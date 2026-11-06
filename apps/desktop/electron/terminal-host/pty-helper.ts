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
 * - `../native/manor-pty/target/release/manor-pty`: a dev build's cargo output
 *
 * `MANOR_PTY_HELPER=node` always picks the Node helper. A native helper that
 * fails to start is remembered for the daemon's lifetime: later sessions go
 * straight to Node.
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
): string[] {
  const shipped = unpackedDir(dir);
  return [
    path.join(shipped, `manor-pty-${platform}-${arch}`),
    path.join(shipped, `manor-pty-${platform}-universal`),
    path.join(
      dir,
      "..",
      "native",
      "manor-pty",
      "target",
      "release",
      "manor-pty",
    ),
  ];
}

export function choosePtyHelper(opts: ChooseOptions = {}): PtyHelper {
  const env = opts.env ?? process.env;
  const dir = opts.dir ?? __dirname;
  const canRun = opts.isExecutable ?? isExecutable;
  const node: PtyHelper = {
    kind: "node",
    path: path.join(dir, "pty-subprocess.js"),
  };

  if (env.MANOR_PTY_HELPER === "node" || nativeBroken) return node;
  const candidates = env.MANOR_PTY_HELPER_PATH
    ? [env.MANOR_PTY_HELPER_PATH]
    : nativeHelperCandidates(
        dir,
        opts.platform ?? process.platform,
        opts.arch ?? process.arch,
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

/** The native helper didn't start: use Node for the rest of this daemon's life. */
export function markNativeHelperBroken(file: string, reason: string): void {
  if (!nativeBroken) {
    console.warn(
      `[terminal-host] manor-pty at ${file} didn't start (${reason}); using pty-subprocess.js`,
    );
  }
  nativeBroken = true;
}

/** For tests. */
export function resetPtyHelperState(): void {
  nativeBroken = false;
  missingLogged = false;
}
