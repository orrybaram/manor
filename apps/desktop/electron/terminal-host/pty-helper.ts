/**
 * Which program a session runs to hold its PTY: the native `manor-pty` when
 * one is shipped for this platform, else `pty-subprocess.js`. Both speak the
 * frame protocol in `pty-subprocess-ipc.ts`.
 *
 * Where `manor-pty` is looked for, next to the daemon bundle (`dir`):
 * - `MANOR_PTY_HELPER_PATH`, when set (tests, local builds)
 * - `manor-pty-<platform>-<arch>`, then `manor-pty-<platform>-universal`,
 *   in the bundle's directory, or in `app.asar.unpacked` when the bundle is
 *   inside an asar archive (nothing in an archive can be executed)
 * - `../native/manor-pty/target/release/manor-pty`, a dev build's cargo
 *   output, only with `MANOR_PTY_DEV=1`: a shipped daemon runs nothing from
 *   outside its own bundle. So `pnpm dev` uses `pty-subprocess.js` unless
 *   that's set or `build-manor-pty.mjs` has put a binary in dist-electron.
 *
 * `MANOR_PTY_HELPER=node` always picks the Node helper. A native helper that
 * can never start (missing, not executable, the wrong architecture) is given
 * up on for the daemon's lifetime at once; one that fails for a passing
 * reason (no free pids or fds, killed before Ready) only after
 * {@link FAILURES_BEFORE_GIVING_UP} failures in a row, so one hiccup doesn't
 * quietly put every later pane on Node.
 */
import fs from "node:fs";
import path from "node:path";

export type PtyHelper =
  { kind: "native"; path: string } | { kind: "node"; path: string };

interface ChooseOptions {
  env?: NodeJS.ProcessEnv;
  dir?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  isExecutable?: (file: string) => boolean;
}

let nativeBroken = false;
/** Failed native starts since the last one that said Ready. */
let failuresInARow = 0;
export const FAILURES_BEFORE_GIVING_UP = 3;

/** Spawn errors that will happen again on every try. */
const PERMANENT_SPAWN_ERRORS: ReadonlySet<string> = new Set([
  "ENOENT",
  "ENOTDIR",
  "EACCES",
  "EPERM",
  "ENOEXEC",
  "EBADARCH",
  "EBADEXEC",
  "EBADMACHO",
]);
/** The "no binary here" line goes to the log once per daemon, not per pane. */
let missingLogged = false;

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** The directory files unpacked from an asar archive live in. */
function unpackedDir(dir: string): string {
  return dir.replace(/\bapp\.asar(?=[/\\]|$)/, "app.asar.unpacked");
}

export function nativeHelperCandidates(
  dir: string,
  platform: NodeJS.Platform,
  arch: string,
  dev = false,
): string[] {
  const shipped = unpackedDir(dir);
  const candidates = [
    path.join(shipped, `manor-pty-${platform}-${arch}`),
    path.join(shipped, `manor-pty-${platform}-universal`),
  ];
  if (dev) {
    candidates.push(
      path.join(
        dir,
        "..",
        "native",
        "manor-pty",
        "target",
        "release",
        "manor-pty",
      ),
    );
  }
  return candidates;
}

/** `pty-subprocess.js`, beside the daemon bundle: the fallback. */
export function nodeHelperPath(dir: string = __dirname): string {
  return path.join(dir, "pty-subprocess.js");
}

export function choosePtyHelper(opts: ChooseOptions = {}): PtyHelper {
  const env = opts.env ?? process.env;
  const dir = opts.dir ?? __dirname;
  const canRun = opts.isExecutable ?? isExecutable;
  const node: PtyHelper = { kind: "node", path: nodeHelperPath(dir) };

  if (env.MANOR_PTY_HELPER === "node" || nativeBroken) return node;
  const candidates = env.MANOR_PTY_HELPER_PATH
    ? [env.MANOR_PTY_HELPER_PATH]
    : nativeHelperCandidates(
        dir,
        opts.platform ?? process.platform,
        opts.arch ?? process.arch,
        env.MANOR_PTY_DEV === "1",
      );
  const found = candidates.find(canRun);
  if (found) return { kind: "native", path: found };
  if (!missingLogged) {
    missingLogged = true;
    console.warn(
      `[terminal-host] no manor-pty for ${opts.platform ?? process.platform}-${opts.arch ?? process.arch} (looked in ${candidates.join(", ")}); using pty-subprocess.js`,
    );
  }
  return node;
}

/**
 * The native helper didn't start. `code` is the spawn error's errno name, if
 * it had one: a permanent one gives up on the native helper for the rest of
 * this daemon's life at once, anything else after
 * {@link FAILURES_BEFORE_GIVING_UP} failures in a row.
 */
export function recordNativeHelperFailure(
  file: string,
  reason: string,
  code?: string,
): void {
  if (nativeBroken) return;
  failuresInARow += 1;
  const permanent = code !== undefined && PERMANENT_SPAWN_ERRORS.has(code);
  if (permanent || failuresInARow >= FAILURES_BEFORE_GIVING_UP) {
    nativeBroken = true;
    console.warn(
      `[terminal-host] manor-pty at ${file} didn't start (${reason}); using pty-subprocess.js from now on`,
    );
  } else {
    console.warn(
      `[terminal-host] manor-pty at ${file} didn't start (${reason}); this pane uses pty-subprocess.js`,
    );
  }
}

/** The native helper said Ready: earlier failures were passing ones. */
export function recordNativeHelperReady(): void {
  failuresInARow = 0;
}

/** For tests. */
export function resetPtyHelperState(): void {
  nativeBroken = false;
  failuresInARow = 0;
  missingLogged = false;
}
