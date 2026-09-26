/**
 * MachineFacts — what a host's machine *is*, as opposed to the commands run
 * on it (ADR-183). Every host answers the same questions about itself: this
 * machine through `fs`/`os`/`path` (`localFacts`), any other one through its
 * `Exec` (`execFacts`). A caller asks the host it has, and never branches on
 * whether that host is local.
 *
 * Replaces the `ShellHost` and `PortsHost` pairs the shell and ports backends
 * each had, which read a remote `$HOME` two different ways.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { toDirSlug } from "../branch-name";
import { worktreesDir } from "../paths";
import type { Exec } from "./exec";

export interface MachineFacts {
  /**
   * The OS, lowercased: `process.platform` locally, `uname -s` elsewhere —
   * `"darwin"` and `"linux"` agree between the two.
   */
  platform(): Promise<"darwin" | "linux" | string>;
  /** The uid commands run as on that machine. */
  uid(): Promise<number>;
  /** The home directory, always an absolute path other than `/`. */
  homeDir(): Promise<string>;
  /** Signal a pid on that machine (never this one's, for a remote host). */
  kill(pid: number, signal: NodeJS.Signals): Promise<void>;
  /** Whether `p` exists there. False when it cannot be checked. */
  exists(p: string): Promise<boolean>;
  /** A UTF-8 file's contents. Rejects when it cannot be read. */
  readFile(p: string): Promise<string>;
  /** Join path segments the way that machine does. */
  join(...parts: string[]): string;
  /** Where a project's worktrees go unless it names a root of its own. */
  defaultWorktreeRoot(projectName: string): Promise<string>;
}

/**
 * Memoize an async lookup, but only its successes: a rejection clears the
 * memo, so the next call asks again instead of replaying the failure.
 */
export function memoRetry<T>(fn: () => Promise<T>): () => Promise<T> {
  let memo: Promise<T> | null = null;
  return () => {
    memo ??= fn().catch((err: unknown) => {
      memo = null;
      throw err;
    });
    return memo;
  };
}

/** `home`, if it is a usable home directory; throws otherwise. */
function validHomeDir(home: string, where: string): string {
  if (!home.startsWith("/") || home === "/") {
    throw new Error(
      `${where} $HOME must be an absolute path other than "/" (got ${JSON.stringify(home)})`,
    );
  }
  return home;
}

/**
 * Join with `/`, for a POSIX machine that may not be this one. Unlike
 * `path.posix.join` it keeps each segment as given apart from its slashes,
 * and never drops the leading `/` of an absolute first segment.
 */
export function posixJoin(...parts: string[]): string {
  const isAbsolute = parts[0]?.startsWith("/") ?? false;
  const joined = parts
    .map((part, i) => (i === 0 ? part.replace(/\/+$/, "") : part.replace(/^\/+|\/+$/g, "")))
    .filter((part) => part.length > 0)
    .join("/");
  return isAbsolute && !joined.startsWith("/") ? `/${joined}` : joined;
}

/** This machine. */
export function localFacts(): MachineFacts {
  return {
    async platform() {
      return process.platform;
    },
    async uid() {
      return process.getuid?.() ?? 0;
    },
    async homeDir() {
      return validHomeDir(os.homedir(), "Local");
    },
    async kill(pid, signal) {
      process.kill(pid, signal);
    },
    async exists(p) {
      return fs.access(p).then(
        () => true,
        () => false,
      );
    },
    readFile(p) {
      return fs.readFile(p, "utf-8");
    },
    join(...parts) {
      return path.join(...parts);
    },
    async defaultWorktreeRoot(projectName) {
      return path.join(worktreesDir(), toDirSlug(projectName));
    },
  };
}

/** How long a single fact query may take on a remote machine. */
const FACT_TIMEOUT_MS = 5000;

/**
 * A machine this process is not running on, asked through `execImpl`.
 * `platform`, `uid` and `homeDir` are asked once and cached; a failed answer
 * is asked again next time.
 */
export function execFacts(execImpl: Exec): MachineFacts {
  const run = async (cmd: string, args: string[]) =>
    (await execImpl.file(cmd, args, { timeout: FACT_TIMEOUT_MS })).stdout;
  // The exec's own default timeout: the first ask may ride a fresh connection.
  const homeDir = memoRetry(async () =>
    validHomeDir(
      (await execImpl.file("sh", ["-c", 'printf %s "$HOME"'])).stdout.trim(),
      "Remote",
    ),
  );
  return {
    platform: memoRetry(async () => (await run("uname", ["-s"])).trim().toLowerCase()),
    uid: memoRetry(async () => {
      // Never fall back to 0: that would, e.g., scan root's listeners.
      const text = (await run("id", ["-u"])).trim();
      const parsed = /^\d+$/.test(text) ? Number(text) : NaN;
      if (!Number.isSafeInteger(parsed)) {
        throw new Error(`\`id -u\` printed an unparseable uid: ${JSON.stringify(text)}`);
      }
      return parsed;
    }),
    homeDir,
    async kill(pid, signal) {
      await execImpl.file("kill", [`-${signal.replace(/^SIG/, "")}`, String(pid)], {
        timeout: FACT_TIMEOUT_MS,
      });
    },
    async exists(p) {
      try {
        await execImpl.file("test", ["-e", p]);
        return true;
      } catch {
        return false;
      }
    },
    async readFile(p) {
      return (await execImpl.file("cat", [p])).stdout;
    },
    join: posixJoin,
    async defaultWorktreeRoot(projectName) {
      return posixJoin(await homeDir(), ".manor", "worktrees", toDirSlug(projectName));
    },
  };
}
