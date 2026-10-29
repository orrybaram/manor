/**
 * Every agent CLI's Sessions on this host: one {@link SessionReader} per
 * agent kind, run side by side, newest first.
 *
 * Electron-free, so the desktop's server and a host server list the same
 * way (`../bridge/handlers/sessions.ts`). Read-only: a reader never writes
 * to the store it reads.
 *
 * Adding an agent kind is adding its reader to {@link defaultSessionReaders}.
 */

import { homedir } from "node:os";

import { errorMessage } from "../lib/errors";
import { createClaudeReader } from "./claude-reader";
import { createOpencodeReader } from "./opencode-reader";
import { createPiReader } from "./pi-reader";
import type { SessionEnv, SessionReader, SessionSummary } from "./types";

export interface SessionScanner {
  /** This host's Sessions, newest first. A scan already running is joined, not repeated. */
  list(): Promise<SessionSummary[]>;
}

/** One reader per agent kind this host can list. */
function defaultSessionReaders(): SessionReader[] {
  return [createClaudeReader(), createOpencodeReader(), createPiReader()];
}

/** This process's home and environment. */
function processEnv(): SessionEnv {
  return { home: homedir(), env: process.env };
}

/**
 * A scanner over `readers`. A reader that fails gives no Sessions this time;
 * the others' still come back.
 */
export function createSessionScanner(
  readers: SessionReader[] = defaultSessionReaders(),
  env: () => SessionEnv = processEnv,
): SessionScanner {
  let running: Promise<SessionSummary[]> | null = null;
  const scan = async (): Promise<SessionSummary[]> => {
    const at = env();
    const lists = await Promise.all(
      readers.map((reader) =>
        reader.list(at).catch((err: unknown) => {
          console.warn(`[sessions] reading ${reader.kind} sessions failed: ${errorMessage(err)}`);
          return [];
        }),
      ),
    );
    return lists.flat().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  };
  return {
    list() {
      running ??= scan().finally(() => {
        running = null;
      });
      return running;
    },
  };
}
