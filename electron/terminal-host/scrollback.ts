/**
 * Scrollback persistence — writes PTY output to disk for cold restore.
 *
 * Each session gets a directory at ~/.manor/sessions/{sessionId}/ with:
 *   - scrollback.bin  — raw PTY output, appended to; cut back to its last
 *                       half once it passes MAX_SCROLLBACK_BYTES
 *   - meta.json       — { cols, rows, cwd, createdAt, endedAt? }
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { scrollbackSessionsDir } from "../paths";

export const SESSIONS_DIR = scrollbackSessionsDir();
export const MAX_SCROLLBACK_BYTES = 5 * 1024 * 1024; // 5MB
/** Where a scrollback past MAX_SCROLLBACK_BYTES is cut back to. */
export const SCROLLBACK_TRUNCATE_TO_BYTES = MAX_SCROLLBACK_BYTES / 2;
export const COLD_RESTORE_MAX_BYTES = 500 * 1024; // 500KB read limit for cold restore

/**
 * A session id is used as a single directory name under `SESSIONS_DIR`, so it
 * must be exactly that — one path segment, no separators, no `.` or `..`.
 *
 * This matters because `POST /sessions/read` accepts an unresolved `target` as
 * a raw pane id, and ADR-161 puts that route on an internet-reachable listener.
 * Without this, a caller could walk out of the sessions directory and read any
 * `scrollback.bin` or `meta.json` on the machine. Real ids are
 * `pane-<uuid>`, so nothing legitimate is turned away.
 */
export function isSafeSessionId(sessionId: string): boolean {
  return (
    sessionId.length > 0 &&
    sessionId !== "." &&
    sessionId !== ".." &&
    !sessionId.includes("/") &&
    !sessionId.includes("\\") &&
    !sessionId.includes("\0") &&
    path.basename(sessionId) === sessionId
  );
}

export interface SessionMeta {
  sessionId: string;
  cols: number;
  rows: number;
  cwd: string | null;
  createdAt: string; // ISO 8601
  endedAt: string | null; // null = unclean shutdown
}

export class ScrollbackWriter {
  readonly sessionId: string;
  readonly sessionDir: string;
  private buffer: Buffer[] = [];
  private bufferSize = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private totalBytes = 0;
  private disposed = false;
  /** What meta.json holds, so a cwd change never has to read it back. */
  private meta: SessionMeta | null = null;
  /** Set while a meta.json write is queued but not started, to coalesce them. */
  private metaWriteQueued = false;

  /**
   * Every disk operation after `init` runs through this chain, one at a time
   * and in order, so appends, truncations and clears never interleave. The
   * daemon runs every session on one event loop; none of this may block it.
   */
  private diskChain: Promise<void> = Promise.resolve();
  /** Operations on `diskChain` that have not finished yet. */
  private pendingOps = 0;

  static readonly FLUSH_INTERVAL_MS = 2000;
  static readonly FLUSH_THRESHOLD_BYTES = 256 * 1024;

  constructor(sessionId: string, sessionsDir: string = SESSIONS_DIR) {
    this.sessionId = sessionId;
    this.sessionDir = path.join(sessionsDir, sessionId);
  }

  private get scrollbackPath(): string {
    return path.join(this.sessionDir, "scrollback.bin");
  }

  private get metaPath(): string {
    return path.join(this.sessionDir, "meta.json");
  }

  /**
   * meta.json is swapped in with a rename, never written in place: a write
   * cut off by a crash would leave a truncated file, and cold restore would
   * then read no meta at all.
   */
  private get metaTmpPath(): string {
    return `${this.metaPath}.tmp`;
  }

  /** Initialize the session directory and write initial meta.json */
  init(meta: Omit<SessionMeta, "createdAt" | "endedAt">): void {
    fs.mkdirSync(this.sessionDir, { recursive: true });

    this.meta = {
      ...meta,
      createdAt: new Date().toISOString(),
      endedAt: null,
    };
    this.writeMetaSync();

    // Create empty scrollback file
    fs.writeFileSync(this.scrollbackPath, "");
    this.totalBytes = 0;
  }

  /** Append PTY output data. Buffered and flushed periodically. */
  append(data: string): void {
    if (this.disposed) return;

    const buf = Buffer.from(data, "utf-8");
    this.buffer.push(buf);
    this.bufferSize += buf.length;

    if (this.bufferSize >= ScrollbackWriter.FLUSH_THRESHOLD_BYTES) {
      void this.flush();
      return;
    }

    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        void this.flush();
      }, ScrollbackWriter.FLUSH_INTERVAL_MS);
    }
  }

  /**
   * Write buffered data to disk. Resolves once it (and everything queued
   * before it) has landed.
   */
  flush(): Promise<void> {
    this.clearFlushTimer();
    const combined = this.takeBuffer();
    if (!combined) return this.whenIdle();

    this.totalBytes += combined.length;
    // Past the cap, cut back to half of it: the file then has room for
    // another 2.5 MB of output before it needs rewriting again, instead of
    // going over on the very next flush.
    const truncate = this.totalBytes > MAX_SCROLLBACK_BYTES;
    if (truncate) this.totalBytes = SCROLLBACK_TRUNCATE_TO_BYTES;

    return this.enqueue(async () => {
      await fsp.appendFile(this.scrollbackPath, combined);
      if (truncate) await this.truncateScrollback();
    });
  }

  /** Resolves once every queued disk operation has finished. */
  whenIdle(): Promise<void> {
    return this.diskChain;
  }

  /**
   * Keep only the last SCROLLBACK_TRUNCATE_TO_BYTES of the file. Reads just
   * that tail, and swaps it in with a rename so a cold-restore reader never
   * sees a half-written file.
   */
  private async truncateScrollback(): Promise<void> {
    const handle = await fsp.open(this.scrollbackPath, "r");
    let tail: Buffer;
    try {
      const { size } = await handle.stat();
      if (size <= SCROLLBACK_TRUNCATE_TO_BYTES) return;
      tail = Buffer.alloc(SCROLLBACK_TRUNCATE_TO_BYTES);
      const { bytesRead } = await handle.read(
        tail,
        0,
        SCROLLBACK_TRUNCATE_TO_BYTES,
        size - SCROLLBACK_TRUNCATE_TO_BYTES,
      );
      tail = tail.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }

    // Find a UTF-8 safe boundary (skip continuation bytes 0x80-0xBF)
    let start = 0;
    while (start < tail.length && (tail[start] & 0xc0) === 0x80) {
      start++;
    }
    const kept = tail.subarray(start);

    const tmpPath = `${this.scrollbackPath}.tmp`;
    await fsp.writeFile(tmpPath, kept);
    await fsp.rename(tmpPath, this.scrollbackPath);
  }

  /** Handle clear-scrollback escape sequence (\e[3J) — truncate scrollback */
  handleClearScrollback(): Promise<void> {
    this.buffer = [];
    this.bufferSize = 0;
    this.totalBytes = 0;
    return this.enqueue(() => fsp.writeFile(this.scrollbackPath, ""));
  }

  /** Update CWD in meta.json. A cwd that did not change writes nothing. */
  updateCwd(cwd: string): Promise<void> {
    if (!this.meta || this.meta.cwd === cwd) return this.whenIdle();
    this.meta.cwd = cwd;
    // A prompt reports its cwd every time it draws; while a write is still
    // waiting its turn it will carry this change too.
    if (this.metaWriteQueued) return this.whenIdle();
    this.metaWriteQueued = true;
    return this.enqueue(() => {
      this.metaWriteQueued = false;
      return this.writeMeta();
    });
  }

  /** Mark session as cleanly ended (writes endedAt to meta.json) */
  end(): void {
    if (!this.meta) return;
    this.meta.endedAt = new Date().toISOString();
    this.writeFinal(
      () => this.writeMetaSync(),
      () => this.writeMeta(),
    );
  }

  /** Dispose — flush and clean up timer */
  dispose(): void {
    this.disposed = true;
    this.clearFlushTimer();
    const combined = this.takeBuffer();
    if (!combined) return;
    this.writeFinal(
      () => fs.appendFileSync(this.scrollbackPath, combined),
      () => fsp.appendFile(this.scrollbackPath, combined),
    );
  }

  /**
   * The last writes a session makes. Run `now` right away when nothing is
   * pending, so it has landed before this returns; otherwise queue `queued`
   * behind the rest, so it cannot overtake them. Daemon shutdown waits on
   * `whenIdle` for those (TerminalHost.disposeAll). This runs once per
   * session, never on the output path.
   */
  private writeFinal(now: () => void, queued: () => Promise<void>): void {
    if (this.pendingOps === 0) {
      try {
        now();
      } catch {
        // the session directory may be gone
      }
      return;
    }
    void this.enqueue(queued);
  }

  private serializeMeta(): string {
    return JSON.stringify(this.meta, null, 2);
  }

  private async writeMeta(): Promise<void> {
    await fsp.writeFile(this.metaTmpPath, this.serializeMeta());
    await fsp.rename(this.metaTmpPath, this.metaPath);
  }

  private writeMetaSync(): void {
    fs.writeFileSync(this.metaTmpPath, this.serializeMeta());
    fs.renameSync(this.metaTmpPath, this.metaPath);
  }

  private takeBuffer(): Buffer | null {
    if (this.buffer.length === 0) return null;
    const combined = Buffer.concat(this.buffer);
    this.buffer = [];
    this.bufferSize = 0;
    return combined;
  }

  private clearFlushTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /** Run `op` after everything already queued. Never rejects. */
  private enqueue(op: () => Promise<void>): Promise<void> {
    this.pendingOps++;
    this.diskChain = this.diskChain
      .then(op)
      .catch(() => {
        // Best-effort persistence: the session directory may be gone, and a
        // failed write must not take the daemon down with it.
      })
      .finally(() => {
        this.pendingOps--;
      });
    return this.diskChain;
  }

  // ── Static readers for cold restore ──

  /** Read meta.json for a session. Returns null if not found. */
  static readMeta(
    sessionId: string,
    sessionsDir: string = SESSIONS_DIR,
  ): SessionMeta | null {
    if (!isSafeSessionId(sessionId)) return null;
    try {
      const metaPath = path.join(sessionsDir, sessionId, "meta.json");
      const raw = fs.readFileSync(metaPath, "utf-8");
      return JSON.parse(raw) as SessionMeta;
    } catch {
      return null;
    }
  }

  /** Read scrollback.bin, truncated to COLD_RESTORE_MAX_BYTES at a UTF-8 safe boundary */
  static readScrollback(
    sessionId: string,
    sessionsDir: string = SESSIONS_DIR,
  ): string {
    if (!isSafeSessionId(sessionId)) return "";
    try {
      const scrollbackPath = path.join(
        sessionsDir,
        sessionId,
        "scrollback.bin",
      );
      const content = fs.readFileSync(scrollbackPath);

      if (content.length <= COLD_RESTORE_MAX_BYTES) {
        return content.toString("utf-8");
      }

      // Truncate from the end, keeping the tail
      const keepFrom = content.length - COLD_RESTORE_MAX_BYTES;

      // Find UTF-8 safe boundary
      let start = keepFrom;
      while (start < content.length && (content[start] & 0xc0) === 0x80) {
        start++;
      }

      return content.subarray(start).toString("utf-8");
    } catch {
      return "";
    }
  }

  /** Check if a session had an unclean shutdown (meta exists but no endedAt) */
  static isUncleanShutdown(
    sessionId: string,
    sessionsDir: string = SESSIONS_DIR,
  ): boolean {
    const meta = ScrollbackWriter.readMeta(sessionId, sessionsDir);
    if (!meta) return false;
    return meta.endedAt === null;
  }

  /** List all session IDs that have persisted data */
  static listPersistedSessions(sessionsDir: string = SESSIONS_DIR): string[] {
    try {
      const entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  }
}
