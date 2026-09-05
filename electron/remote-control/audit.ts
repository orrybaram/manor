/**
 * Append-only log of every remote-control write (ADR-161 §4).
 *
 * The one route on the remote surface that can act types into a live shell, so
 * there has to be an answer to "what did that device do". This is that answer,
 * and it is deliberately a plain JSONL file rather than anything queryable: it
 * is written on a path that must not fail, and read rarely.
 *
 * **The text is never recorded** — only its length and SHA-256. Scrollback and
 * prompts routinely carry API keys, and an audit log that quietly accumulates
 * them is a worse leak than the thing it audits. The hash is enough to answer
 * "was this the same text twice" and to corroborate a message the user still
 * has.
 *
 * Electron-free on purpose (`fs` only), so it is testable without a mock and
 * usable from anywhere in main.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { remoteAuditFile } from "../paths";

/** One line. Every field is safe to keep — see the header on `textSha256`. */
export interface RemoteAuditEntry {
  at: string;
  deviceId: string;
  deviceLabel: string;
  route: string;
  /** The `target` the caller named — an agent id, pane id, or branch. */
  target: string | null;
  textLength: number | null;
  textSha256: string | null;
  /**
   * True for `POST /sessions/interrupt`, and for a send that carried an
   * override of the interrupt sequence. Either way something ended a turn.
   */
  interrupt: boolean;
  outcome: "sent" | "rejected" | "failed";
  /** The HTTP status the caller actually saw. */
  status: number;
  /** Present when `outcome` is not "sent". Never contains request text. */
  reason?: string;
}

/** Rotate at 512 KB. One generation is kept — this is a trail, not an archive. */
const MAX_BYTES = 512 * 1024;

export function hashText(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

export class RemoteAuditLog {
  constructor(private readonly filePath: string = remoteAuditFile()) {}

  /**
   * Append one line. Never throws: an audit write that fails must not become a
   * way to break the request path, and the caller has nothing useful to do
   * about a full disk. It does log, loudly.
   */
  append(entry: RemoteAuditEntry): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      this.rotateIfNeeded();
      fs.appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, {
        mode: 0o600,
      });
      // `mode` applies only at creation; restate it so an existing file cannot
      // sit at a laxer mode from an earlier version or a restored backup.
      fs.chmodSync(this.filePath, 0o600);
    } catch (err) {
      console.error("[remote-control] failed to write audit entry:", err);
    }
  }

  /** Every entry currently in the live file. Malformed lines are skipped. */
  read(): RemoteAuditEntry[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, "utf8");
    } catch {
      return [];
    }
    const entries: RemoteAuditEntry[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as RemoteAuditEntry);
      } catch {
        // A torn final line from a crash mid-append. Skip it.
      }
    }
    return entries;
  }

  private rotateIfNeeded(): void {
    let size: number;
    try {
      size = fs.statSync(this.filePath).size;
    } catch {
      return; // No file yet.
    }
    if (size < MAX_BYTES) return;
    fs.renameSync(this.filePath, `${this.filePath}.1`);
    try {
      fs.chmodSync(`${this.filePath}.1`, 0o600);
    } catch {
      // Best effort — the rename preserved the mode anyway.
    }
  }
}
