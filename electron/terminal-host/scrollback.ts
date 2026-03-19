/**
 * Scrollback persistence — writes PTY output to disk for cold restore.
 *
 * Each session gets a directory at ~/.manor/sessions/{sessionId}/ with:
 *   - scrollback.bin  — raw PTY output, append-only
 *   - meta.json       — { cols, rows, cwd, createdAt, endedAt? }
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export const SESSIONS_DIR = path.join(os.homedir(), ".manor", "sessions");
export const MAX_SCROLLBACK_BYTES = 5 * 1024 * 1024; // 5MB
export const COLD_RESTORE_MAX_BYTES = 500 * 1024; // 500KB read limit for cold restore

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

  /** Initialize the session directory and write initial meta.json */
  init(meta: Omit<SessionMeta, "createdAt" | "endedAt">): void {
    fs.mkdirSync(this.sessionDir, { recursive: true });

    const fullMeta: SessionMeta = {
      ...meta,
      createdAt: new Date().toISOString(),
      endedAt: null,
    };
    fs.writeFileSync(this.metaPath, JSON.stringify(fullMeta, null, 2));

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
      this.flush();
      return;
    }

    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flush();
      }, ScrollbackWriter.FLUSH_INTERVAL_MS);
    }
  }

  /** Force flush buffered data to disk */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.buffer.length === 0) return;

    const combined = Buffer.concat(this.buffer);
    this.buffer = [];
    this.bufferSize = 0;

    fs.appendFileSync(this.scrollbackPath, combined);
    this.totalBytes += combined.length;

    // Enforce size cap
    if (this.totalBytes > MAX_SCROLLBACK_BYTES) {
      this.truncateScrollback();
    }
  }

  /** Truncate scrollback to stay within MAX_SCROLLBACK_BYTES */
  private truncateScrollback(): void {
    const stat = fs.statSync(this.scrollbackPath);
    if (stat.size <= MAX_SCROLLBACK_BYTES) {
      this.totalBytes = stat.size;
      return;
    }

    // Read the file, keep the tail
    const content = fs.readFileSync(this.scrollbackPath);
    const keepFrom = content.length - MAX_SCROLLBACK_BYTES;

    // Find a UTF-8 safe boundary (skip continuation bytes 0x80-0xBF)
    let start = keepFrom;
    while (start < content.length && (content[start] & 0xc0) === 0x80) {
      start++;
    }

    const truncated = content.subarray(start);
    fs.writeFileSync(this.scrollbackPath, truncated);
    this.totalBytes = truncated.length;
  }

  /** Handle clear-scrollback escape sequence (\e[3J) — truncate scrollback */
  handleClearScrollback(): void {
    this.buffer = [];
    this.bufferSize = 0;
    fs.writeFileSync(this.scrollbackPath, "");
    this.totalBytes = 0;
  }

  /** Update CWD in meta.json */
  updateCwd(cwd: string): void {
    try {
      const raw = fs.readFileSync(this.metaPath, "utf-8");
      const meta = JSON.parse(raw) as SessionMeta;
      meta.cwd = cwd;
      fs.writeFileSync(this.metaPath, JSON.stringify(meta, null, 2));
    } catch {
      // meta file may not exist yet
    }
  }

  /** Mark session as cleanly ended (writes endedAt to meta.json) */
  end(): void {
    try {
      const raw = fs.readFileSync(this.metaPath, "utf-8");
      const meta = JSON.parse(raw) as SessionMeta;
      meta.endedAt = new Date().toISOString();
      fs.writeFileSync(this.metaPath, JSON.stringify(meta, null, 2));
    } catch {
      // meta file may not exist
    }
  }

  /** Dispose — flush and clean up timer */
  dispose(): void {
    this.disposed = true;
    this.flush();
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  // ── Static readers for cold restore ──

  /** Read meta.json for a session. Returns null if not found. */
  static readMeta(sessionId: string, sessionsDir: string = SESSIONS_DIR): SessionMeta | null {
    try {
      const metaPath = path.join(sessionsDir, sessionId, "meta.json");
      const raw = fs.readFileSync(metaPath, "utf-8");
      return JSON.parse(raw) as SessionMeta;
    } catch {
      return null;
    }
  }

  /** Read scrollback.bin, truncated to COLD_RESTORE_MAX_BYTES at a UTF-8 safe boundary */
  static readScrollback(sessionId: string, sessionsDir: string = SESSIONS_DIR): string {
    try {
      const scrollbackPath = path.join(sessionsDir, sessionId, "scrollback.bin");
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
  static isUncleanShutdown(sessionId: string, sessionsDir: string = SESSIONS_DIR): boolean {
    const meta = ScrollbackWriter.readMeta(sessionId, sessionsDir);
    if (!meta) return false;
    return meta.endedAt === null;
  }

  /** List all session IDs that have persisted data */
  static listPersistedSessions(sessionsDir: string = SESSIONS_DIR): string[] {
    try {
      const entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return [];
    }
  }
}
