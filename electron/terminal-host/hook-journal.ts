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
 * file, not stored anywhere else).
 *
 * Crash safety without fsync: appends are single `write`s of a whole line,
 * and compaction goes through tmp + rename. A crash can at worst leave a torn
 * last line, which recovery skips; `open()` always rewrites the file, so the
 * next append never lands on the end of a torn line.
 *
 * Bounded by count and age (default 5,000 entries / 7 days), enforced at
 * `open()` and every `compactEvery` appends. The in-memory copy mirrors the
 * file so replay never re-reads it.
 *
 * Electron-free: the daemon bundle imports this.
 */

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
  if (record.payload === undefined) return { seq: record.seq, receivedAt };
  if (!record.payload || typeof record.payload !== "object") return null;
  return { seq: record.seq, receivedAt, payload: record.payload };
}

function isEntry(record: HookJournalEntry | Watermark): record is HookJournalEntry {
  return "payload" in record;
}

export class HookJournal {
  private entries: HookJournalEntry[] = [];
  private seq = 0;
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
   * Load the file, recovering the last seq and skipping unreadable lines
   * (a torn last line after a crash), then compact. Safe to call on a
   * missing file.
   */
  open(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    let text = "";
    try {
      text = fs.readFileSync(this.file, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const entries: HookJournalEntry[] = [];
    let seq = 0;
    let skipped = 0;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const record = parseLine(line);
      if (!record) {
        skipped++;
        continue;
      }
      seq = Math.max(seq, record.seq);
      // Entries are appended in seq order; anything out of order is damage.
      if (isEntry(record) && record.seq > (entries[entries.length - 1]?.seq ?? 0)) {
        entries.push(record);
      }
    }
    if (skipped > 0) this.log(`hook journal: skipped ${skipped} unreadable line(s)`);
    this.entries = entries;
    this.seq = seq;
    this.compact();
  }

  /** Journal one hook; returns its entry. Never throws on a write failure. */
  append(payload: HookPayload): HookJournalEntry {
    const entry: HookJournalEntry = {
      seq: ++this.seq,
      receivedAt: this.now(),
      payload,
    };
    this.entries.push(entry);
    try {
      fs.appendFileSync(this.file, JSON.stringify(entry) + "\n", { mode: 0o600 });
    } catch (err) {
      this.log(`hook journal: append failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (++this.appendsSinceCompact >= this.compactEvery) this.compact();
    return entry;
  }

  /** Entries with `seq > sinceSeq`, oldest first, within the age cap. */
  since(sinceSeq: number): HookJournalEntry[] {
    const cutoff = this.now() - this.maxAgeMs;
    return this.entries.filter((e) => e.seq > sinceSeq && e.receivedAt >= cutoff);
  }

  /** Drop entries past the caps and rewrite the file (tmp + rename). */
  compact(): void {
    this.appendsSinceCompact = 0;
    const cutoff = this.now() - this.maxAgeMs;
    let kept = this.entries.filter((e) => e.receivedAt >= cutoff);
    if (kept.length > this.maxEntries) kept = kept.slice(kept.length - this.maxEntries);
    this.entries = kept;
    const watermark: Watermark = { seq: this.seq, receivedAt: this.now() };
    const lines = [watermark, ...kept].map((r) => JSON.stringify(r) + "\n").join("");
    const tmp = `${this.file}.tmp`;
    try {
      fs.writeFileSync(tmp, lines, { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      fs.chmodSync(this.file, 0o600);
    } catch (err) {
      this.log(`hook journal: compaction failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
