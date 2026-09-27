/**
 * Hook journal — the remote daemon's durable record of agent hooks
 * (ADR-178 §2).
 *
 * While the laptop is closed nothing is listening for a remote agent's hooks
 * but the daemon. It appends each one here with a `seq`, and Electron main
 * replays everything after the last `seq` it ingested when it reconnects.
 *
 * File format: NDJSON, one `HookJournalEntry` per line, mode 0600. A line
 * with no `payload` is a *watermark*: compaction writes one first so the
 * highest seq survives even when every entry has aged out, which is what
 * keeps `seq` monotonic across daemon restarts (it is recovered from the
 * file, not stored anywhere else). The watermark also carries the journal's
 * `epoch`: a random id minted when the journal is created. Main stores it
 * beside its last seq, so a journal that was deleted and started over is
 * recognised as new even once its seq has passed the old one.
 *
 * Crash safety without fsync: appends are single `write`s of a whole line,
 * and compaction goes through tmp + rename. A crash can at worst leave a torn
 * last line, which recovery skips; `open()` rewrites the file, and if that
 * rewrite fails it cuts the torn line off instead, so the next append never
 * lands on the end of one.
 *
 * Bounded by count and age (default 5,000 entries / 7 days), enforced at
 * `open()` and every `compactEvery` appends. The in-memory copy mirrors the
 * file so replay never re-reads it.
 *
 * Electron-free: the daemon bundle imports this.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type { HookJournalEntry, HookPayload } from "./types";

export const HOOK_JOURNAL_MAX_ENTRIES = 5_000;
export const HOOK_JOURNAL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const HOOK_JOURNAL_COMPACT_EVERY = 500;

export interface HookJournalOptions {
  maxEntries?: number;
  maxAgeMs?: number;
  /** Compact after this many appends. */
  compactEvery?: number;
  /** Wall clock, for tests. */
  now?: () => number;
  log?: (message: string) => void;
}

interface Watermark {
  seq: number;
  receivedAt: number;
  /** Absent in journals written before epochs existed. */
  epoch?: string;
}

function newEpoch(): string {
  return crypto.randomBytes(8).toString("hex");
}

function parseLine(line: string): HookJournalEntry | Watermark | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<HookJournalEntry>;
  if (typeof record.seq !== "number" || !Number.isSafeInteger(record.seq) || record.seq < 0) {
    return null;
  }
  const receivedAt = typeof record.receivedAt === "number" ? record.receivedAt : 0;
  if (record.payload === undefined) {
    const epoch = (value as { epoch?: unknown }).epoch;
    return typeof epoch === "string" && epoch
      ? { seq: record.seq, receivedAt, epoch }
      : { seq: record.seq, receivedAt };
  }
  if (!record.payload || typeof record.payload !== "object") return null;
  return { seq: record.seq, receivedAt, payload: record.payload };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isEntry(record: HookJournalEntry | Watermark): record is HookJournalEntry {
  return "payload" in record;
}

export class HookJournal {
  private entries: HookJournalEntry[] = [];
  private seq = 0;
  private journalEpoch = "";
  /** The file may end mid-line (see `open`); the next append starts a new one. */
  private needsLeadingNewline = false;
  private appendsSinceCompact = 0;
  private readonly maxEntries: number;
  private readonly maxAgeMs: number;
  private readonly compactEvery: number;
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  constructor(
    private readonly file: string,
    opts: HookJournalOptions = {},
  ) {
    this.maxEntries = opts.maxEntries ?? HOOK_JOURNAL_MAX_ENTRIES;
    this.maxAgeMs = opts.maxAgeMs ?? HOOK_JOURNAL_MAX_AGE_MS;
    this.compactEvery = opts.compactEvery ?? HOOK_JOURNAL_COMPACT_EVERY;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
  }

  /** The highest seq ever handed out (0 for a journal that has never had one). */
  get lastSeq(): number {
    return this.seq;
  }

  /**
   * This journal's identity: minted when the journal is created and kept
   * across daemon restarts. A different epoch means a different journal,
   * whatever its seqs say. Empty until `open()`.
   */
  get epoch(): string {
    return this.journalEpoch;
  }

  /**
   * Load the file, recovering the last seq and epoch and skipping unreadable
   * lines (a torn last line after a crash), then compact. Safe to call on a
   * missing file.
   */
  open(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    let raw = Buffer.alloc(0);
    try {
      raw = fs.readFileSync(this.file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const text = raw.toString("utf-8");
    const entries: HookJournalEntry[] = [];
    let seq = 0;
    let epoch: string | undefined;
    let skipped = 0;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const record = parseLine(line);
      if (!record) {
        skipped++;
        continue;
      }
      seq = Math.max(seq, record.seq);
      if (!isEntry(record) && record.epoch) epoch = record.epoch;
      // Entries are appended in seq order; anything out of order is damage.
      if (isEntry(record) && record.seq > (entries[entries.length - 1]?.seq ?? 0)) {
        entries.push(record);
      }
    }
    if (skipped > 0) this.log(`hook journal: skipped ${skipped} unreadable line(s)`);
    this.entries = entries;
    this.seq = seq;
    this.journalEpoch = epoch ?? newEpoch();
    if (!this.compact()) this.repairAfterFailedCompaction(raw, epoch === undefined);
  }

  /**
   * `open()` could not rewrite the file, so whatever it held is still there,
   * possibly ending in a torn line. Cut that line off (or, failing that,
   * start the next append on a fresh line), and record a newly minted epoch
   * so the next `open()` recovers the same one.
   */
  private repairAfterFailedCompaction(raw: Buffer, epochIsNew: boolean): void {
    if (raw.length > 0 && raw[raw.length - 1] !== 0x0a) {
      try {
        fs.truncateSync(this.file, raw.lastIndexOf(0x0a) + 1);
      } catch (err) {
        this.log(`hook journal: could not trim a torn line: ${errorMessage(err)}`);
        this.needsLeadingNewline = true;
      }
    }
    if (epochIsNew) this.appendLine({ seq: this.seq, receivedAt: this.now(), epoch: this.journalEpoch });
  }

  /** Append one record as a single write. Never throws. */
  private appendLine(record: HookJournalEntry | Watermark): void {
    const line = (this.needsLeadingNewline ? "\n" : "") + JSON.stringify(record) + "\n";
    try {
      fs.appendFileSync(this.file, line, { mode: 0o600 });
      this.needsLeadingNewline = false;
    } catch (err) {
      this.log(`hook journal: append failed: ${errorMessage(err)}`);
    }
  }

  /** Journal one hook; returns its entry. Never throws on a write failure. */
  append(payload: HookPayload): HookJournalEntry {
    const entry: HookJournalEntry = {
      seq: ++this.seq,
      receivedAt: this.now(),
      payload,
    };
    this.entries.push(entry);
    this.appendLine(entry);
    if (++this.appendsSinceCompact >= this.compactEvery) this.compact();
    return entry;
  }

  /** Entries with `seq > sinceSeq`, oldest first, within the age cap. */
  since(sinceSeq: number): HookJournalEntry[] {
    const cutoff = this.now() - this.maxAgeMs;
    return this.entries.filter((e) => e.seq > sinceSeq && e.receivedAt >= cutoff);
  }

  /**
   * Drop entries past the caps and rewrite the file (tmp + rename). Returns
   * false (and logs) if the rewrite failed, leaving the old file in place.
   */
  compact(): boolean {
    this.appendsSinceCompact = 0;
    const cutoff = this.now() - this.maxAgeMs;
    let kept = this.entries.filter((e) => e.receivedAt >= cutoff);
    if (kept.length > this.maxEntries) kept = kept.slice(kept.length - this.maxEntries);
    this.entries = kept;
    const watermark: Watermark = {
      seq: this.seq,
      receivedAt: this.now(),
      epoch: this.journalEpoch || (this.journalEpoch = newEpoch()),
    };
    const lines = [watermark, ...kept].map((r) => JSON.stringify(r) + "\n").join("");
    const tmp = `${this.file}.tmp`;
    try {
      fs.writeFileSync(tmp, lines, { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      fs.chmodSync(this.file, 0o600);
      this.needsLeadingNewline = false;
      return true;
    } catch (err) {
      this.log(`hook journal: compaction failed: ${errorMessage(err)}`);
      return false;
    }
  }
}
