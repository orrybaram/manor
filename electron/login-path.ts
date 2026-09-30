/**
 * Login-shell PATH for packaged builds.
 *
 * Launched from Finder/Dock, macOS hands the app a minimal PATH. Asking a
 * login shell for the real one used to block startup (`execFileSync`, up to
 * 3 s). Instead the last resolved PATH is cached on disk and applied
 * synchronously; the login shell runs in the background and refreshes it.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loginPathFile } from "./paths";

const COMMON_PATHS = ["/opt/homebrew/bin", "/usr/local/bin"];

interface LoginPathCache {
  path: string;
  shell: string;
}

/** Seams for tests. */
export interface LoginPathDeps {
  readFile: (file: string) => string;
  writeFile: (file: string, data: string) => void;
  mkdir: (dir: string) => void;
  execFile: (
    shell: string,
    args: string[],
    opts: { timeout: number; encoding: "utf-8" },
    cb: (err: Error | null, stdout: string) => void,
  ) => void;
  cacheFilePath: () => string;
}

const defaultDeps: LoginPathDeps = {
  readFile: (file) => fs.readFileSync(file, "utf-8"),
  writeFile: (file, data) => fs.writeFileSync(file, data),
  mkdir: (dir) => {
    fs.mkdirSync(dir, { recursive: true });
  },
  execFile: (shell, args, opts, cb) => {
    execFile(shell, args, opts, (err, stdout) => cb(err, stdout));
  },
  cacheFilePath: loginPathFile,
};

function currentShell(): string {
  return process.env.SHELL || "/bin/zsh";
}

let loginPathSettled: Promise<void> = Promise.resolve();

/** The cached login PATH, or null when absent, malformed or for another shell. */
export function readCachedLoginPath(
  deps: Pick<LoginPathDeps, "readFile" | "cacheFilePath"> = defaultDeps,
): string | null {
  try {
    const cache = JSON.parse(
      deps.readFile(deps.cacheFilePath()),
    ) as Partial<LoginPathCache>;
    if (typeof cache.path !== "string" || !cache.path) return null;
    if (cache.shell !== currentShell()) return null;
    return cache.path;
  } catch {
    return null;
  }
}

/** Prepend Homebrew's usual locations to `current` when they are missing. */
export function withCommonPaths(current: string): string {
  const segments = current.split(":");
  const missing = COMMON_PATHS.filter((p) => !segments.includes(p));
  return missing.length ? [...missing, current].join(":") : current;
}

/** Ask a login shell for its PATH. Resolves null on any failure. */
export function resolveLoginPath(
  shell: string,
  run: LoginPathDeps["execFile"] = defaultDeps.execFile,
): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      run(
        shell,
        ["-lc", "echo $PATH"],
        { timeout: 3000, encoding: "utf-8" },
        (err, stdout) => {
          const result = err ? "" : String(stdout).trim();
          resolve(result || null);
        },
      );
    } catch {
      resolve(null);
    }
  });
}

function writeCache(value: string, shell: string, deps: LoginPathDeps): void {
  try {
    const file = deps.cacheFilePath();
    deps.mkdir(path.dirname(file));
    const cache: LoginPathCache = { path: value, shell };
    deps.writeFile(file, JSON.stringify(cache));
  } catch (err) {
    console.warn("[login-path] failed to write cache:", err);
  }
}

/**
 * Apply the cached PATH (or the common-paths fallback) synchronously, then
 * resolve the real one in the background. Call once, when packaged.
 */
export function startLoginPathResolution(
  deps: LoginPathDeps = defaultDeps,
): void {
  const shell = currentShell();
  const cached = readCachedLoginPath(deps);
  process.env.PATH = cached ?? withCommonPaths(process.env.PATH || "");

  const resolving = resolveLoginPath(shell, deps.execFile).then((resolved) => {
    if (!resolved) return;
    process.env.PATH = resolved;
    if (resolved !== cached) writeCache(resolved, shell, deps);
  });

  // With a cache the PATH already is last run's login PATH; nothing to wait for.
  loginPathSettled = cached ? Promise.resolve() : resolving;
}

/** Settles once the login PATH is usable. Never rejects. */
export function loginPathReady(): Promise<void> {
  return loginPathSettled;
}
