/**
 * A workspace's files, for the file pane: list, read, write and create.
 *
 * Everything runs through the host's `ShellBackend`, never `fs`, so a remote
 * host's workspace is read and written on its own machine exactly as a local
 * one is: the same `sh`, `git`, `cat` and `wc`, through whichever `Exec` the
 * host's backend was built over. Each read is one command (the path checks,
 * the size and binary refusals and the content), so a remote read is one
 * round trip.
 *
 * **Paths stay inside the workspace.** A `relPath` is refused before anything
 * runs if it is absolute or has an empty, `.` or `..` segment; on the host,
 * the nearest existing directory of the target is resolved physically
 * (`cd -P`) and must be under the workspace's own physical path, and a
 * symlink at the target must resolve under it too. A symlink planted between
 * the check and the read is not guarded against.
 *
 * Content is UTF-8 text. `hash` is the SHA-256 of that text, so a caller
 * compares what it read, what it wrote and what `files.changed` reports
 * (`./open-file-watcher.ts`) without the content.
 */

import { createHash, randomBytes } from "node:crypto";
import { posix } from "node:path";
import type { ShellBackend } from "./backend/types";
import { errorMessage } from "./lib/errors";

/** Larger files are refused rather than opened. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** How much of a file is looked at for a NUL byte to call it binary. */
export const BINARY_SNIFF_BYTES = 8192;

/** At most this many paths are listed; the rest are dropped and `truncated` says so. */
export const MAX_LISTED_FILES = 50_000;

/** Output past this is cut off: a listing this large is truncated anyway. */
const MAX_LISTING_BYTES = 64 * 1024 * 1024;

/** A command that runs on a host that may be at the end of an ssh link. */
const COMMAND_TIMEOUT_MS = 30_000;

/** How deep the walk outside a git repo goes. */
const WALK_MAX_DEPTH = 24;

/** The slice of a host's backend this module runs commands through. */
export type FilesBackend = { shell: Pick<ShellBackend, "exec" | "writeFile"> };

/** Why a file call did not do what it was asked. */
export type FileFailureReason =
  /** The path leaves the workspace: absolute, `..`, or a symlink out. */
  | "outside-workspace"
  /** Nothing at the path (read). */
  | "not-found"
  /** Something at the path, but not a regular file (a directory). */
  | "not-a-file"
  /** Over `MAX_FILE_BYTES`; `size` says by how much. */
  | "too-large"
  /** A NUL byte in its first `BINARY_SNIFF_BYTES`, or not UTF-8. */
  | "binary"
  /** `write` with an `expectedHash` the file on disk no longer has, or that is gone. */
  | "changed-on-disk"
  /** `create` of a path that already exists. */
  | "exists";

/** A refusal, with a message the UI can show as it is. */
export interface FileFailure {
  ok: false;
  reason: FileFailureReason;
  message: string;
  /** `too-large`: the file's size in bytes. */
  size?: number;
  /**
   * `changed-on-disk`: the hash the file has now, or null when it is gone.
   */
  diskHash?: string | null;
}

/** What `files.list` answers. */
export interface FileListResult {
  /** Every file, relative to the workspace, `/`-separated, sorted. */
  paths: string[];
  /** More files than `MAX_LISTED_FILES` (or than the walk reached): some are missing. */
  truncated: boolean;
  /** `git`: tracked and untracked-not-ignored; `walk`: a directory walk outside git. */
  source: "git" | "walk";
}

export type FileReadResult = { ok: true; content: string; hash: string } | FileFailure;

export type FileWriteResult = { ok: true; hash: string } | FileFailure;

/** The hash `read`, `write` and `files.changed` all use. */
export function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

/** Whether `relPath` names something inside a workspace by its shape alone. */
export function isSafeRelPath(relPath: string): boolean {
  // Control characters (NUL and newline among them) are refused outright.
  if (relPath.length === 0 || /[\u0000-\u001f\u007f]/.test(relPath) || relPath.includes("\\")) return false;
  if (relPath.startsWith("/") || /^[A-Za-z]:/.test(relPath)) return false;
  return relPath.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

// ── The host-side checks ──
//
// One `sh` script per call, `$1` the workspace, `$2` the relative path, `$3`
// the size limit. Its exit code says why it refused (`EXIT`); anything else
// non-zero is an error.

const EXIT = {
  noWorkspace: 10,
  notFound: 11,
  notAFile: 12,
  outside: 13,
  tooLarge: 14,
  exists: 16,
  /** A write's `expectedHash` check: the file is gone. */
  deleted: 17,
  /** A write's `expectedHash` check: the file hashes to something else (printed). */
  changed: 18,
} as const;

/**
 * Sets `root` (the workspace's physical path) and `f` (the target), and exits
 * `outside` unless the target's nearest existing directory, and a symlink at
 * the target, resolve under `root`; `t` is where that symlink resolves.
 *
 * Every `$(…)` that captures a path ends in a sentinel `x` that is cut off
 * after (`${v%??}`): command substitution strips trailing newlines, and a
 * path that ends in one would otherwise name a different file.
 */
const CONTAIN = `
root=$(cd -P -- "$1" 2>/dev/null && pwd -P && echo x) || exit ${EXIT.noWorkspace}
root=\${root%??}
f="$1/$2"
p=$(dirname -- "$f"; echo x); p=\${p%??}
while [ ! -d "$p" ]; do p=$(dirname -- "$p"; echo x); p=\${p%??}; done
d=$(cd -P -- "$p" 2>/dev/null && pwd -P && echo x) || exit ${EXIT.outside}
d=\${d%??}
case "$d/" in "$root"/*) ;; *) exit ${EXIT.outside} ;; esac
if [ -L "$f" ]; then
  t=$( (readlink -f -- "$f" 2>/dev/null || realpath -- "$f" 2>/dev/null) && echo x) || exit ${EXIT.outside}
  t=\${t%??}
  case "$t/" in "$root"/*) ;; *) exit ${EXIT.outside} ;; esac
fi
`;

/** Contain, refuse what is missing or too large, then print it as base64. */
const READ_SCRIPT = `${CONTAIN}
[ -e "$f" ] || exit ${EXIT.notFound}
[ -f "$f" ] || exit ${EXIT.notAFile}
size=$(wc -c < "$f" | tr -d ' ')
if [ "$size" -gt "$3" ]; then echo "$size"; exit ${EXIT.tooLarge}; fi
base64 < "$f"
`;

/**
 * Before a write's temp file is uploaded: contain, refuse a directory at the
 * target (and, `$3` set, a target that is gone), and make the target's folder
 * so the temp file can sit beside it, checking it is still inside.
 */
const WRITE_PREPARE_SCRIPT = `${CONTAIN}
if [ -e "$f" ] && [ ! -f "$f" ]; then exit ${EXIT.notAFile}; fi
if [ -n "$3" ] && [ ! -e "$f" ]; then exit ${EXIT.deleted}; fi
dir=$(dirname -- "$f"; echo x); dir=\${dir%??}
mkdir -p -- "$dir" || exit 1
d=$(cd -P -- "$dir" 2>/dev/null && pwd -P && echo x) || exit ${EXIT.outside}
d=\${d%??}
case "$d/" in "$root"/*) ;; *) exit ${EXIT.outside} ;; esac
`;

/**
 * The write itself, one step on the host: `$3` is the uploaded temp file
 * (relative, beside the target), `$4` the expected hash or empty. Contain
 * again, then — `$4` set — hash the target and refuse unless it matches; keep
 * the target's mode; and `mv` the temp file over it. The temp file is
 * removed whichever way this ends. A symlink at the target (inside, as
 * contained) is written through, as a plain write would.
 */
const WRITE_COMMIT_SCRIPT = `
tmp="$1/$3"
trap 'rm -f -- "$tmp"' EXIT
${CONTAIN}
if [ -L "$f" ]; then f=$t; fi
if [ -e "$f" ] && [ ! -f "$f" ]; then exit ${EXIT.notAFile}; fi
if [ -n "$4" ]; then
  [ -e "$f" ] || exit ${EXIT.deleted}
  if command -v sha256sum >/dev/null 2>&1; then h=$(sha256sum < "$f") || exit 1
  else h=$(shasum -a 256 < "$f") || exit 1; fi
  h=\${h%% *}
  if [ "$h" != "$4" ]; then printf '%s' "$h"; exit ${EXIT.changed}; fi
fi
if [ -f "$f" ]; then
  m=$(stat -c %a -- "$f" 2>/dev/null || stat -f %Lp -- "$f" 2>/dev/null) && chmod "$m" "$tmp" 2>/dev/null
fi
mv -f -- "$tmp" "$f" || exit 1
`;

/** Contain, then make an empty file, failing if anything is already there. */
const CREATE_SCRIPT = `${CONTAIN}
if [ -e "$f" ] || [ -L "$f" ]; then exit ${EXIT.exists}; fi
dir=$(dirname -- "$f"; echo x); dir=\${dir%??}
mkdir -p -- "$dir" || exit 1
( set -C; : > "$f" ) 2>/dev/null || exit ${EXIT.exists}
`;

/** The host-side scripts, for tests that run them past the shape check. */
export const HOST_SCRIPTS = {
  read: READ_SCRIPT,
  writePrepare: WRITE_PREPARE_SCRIPT,
  writeCommit: WRITE_COMMIT_SCRIPT,
  create: CREATE_SCRIPT,
  /** The exit code for a path that leaves the workspace. */
  outsideExit: EXIT.outside,
} as const;

/** The exit code of a failed `shell.exec`, if it ran and exited. */
function exitCodeOf(err: unknown): number | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "number" ? code : null;
}

function failure(reason: FileFailureReason, message: string, extra: Partial<FileFailure> = {}): FileFailure {
  return { ok: false, reason, message, ...extra };
}

/**
 * Turn a host-side refusal (`EXIT`) into its `FileFailure`; anything else is
 * rethrown, as is a missing workspace.
 */
function refusal(err: unknown, relPath: string): FileFailure {
  const stdout = (err as { stdout?: unknown } | null)?.stdout;
  switch (exitCodeOf(err)) {
    case EXIT.noWorkspace:
      throw new Error("The workspace folder does not exist", { cause: err });
    case EXIT.notFound:
      return failure("not-found", `${relPath} does not exist`);
    case EXIT.notAFile:
      return failure("not-a-file", `${relPath} is not a file`);
    case EXIT.outside:
      return failure("outside-workspace", `${relPath} is outside the workspace`);
    case EXIT.tooLarge: {
      const size = Number.parseInt(typeof stdout === "string" ? stdout : "", 10);
      return failure(
        "too-large",
        `${relPath} is too large to open (over ${MAX_FILE_BYTES / (1024 * 1024)} MB)`,
        Number.isFinite(size) ? { size } : {},
      );
    }
    case EXIT.deleted:
      return failure("changed-on-disk", `${relPath} was deleted on disk`, { diskHash: null });
    case EXIT.changed: {
      const diskHash = typeof stdout === "string" ? stdout.trim() : "";
      return failure("changed-on-disk", `${relPath} changed on disk`, { diskHash: diskHash || null });
    }
    case EXIT.exists:
      return failure("exists", `${relPath} already exists`);
    default:
      throw err;
  }
}

function sh(backend: FilesBackend, script: string, args: string[], maxBuffer?: number): Promise<string> {
  return backend.shell.exec("sh", ["-c", script, "sh", ...args], {
    timeout: COMMAND_TIMEOUT_MS,
    ...(maxBuffer === undefined ? {} : { maxBuffer }),
  });
}

/** `relPath`'s shape is refused before anything runs on the host. */
function shapeRefusal(relPath: string): FileFailure | null {
  return isSafeRelPath(relPath)
    ? null
    : failure("outside-workspace", `${relPath || "(empty path)"} is outside the workspace`);
}

/** Room for `MAX_FILE_BYTES` as base64 (GNU wraps it at 76 columns), and a little. */
const READ_MAX_BUFFER = Math.ceil(((MAX_FILE_BYTES * 4) / 3) * (77 / 76)) + 64 * 1024;

/** Decodes the bytes as they are: a BOM is kept, and anything not UTF-8 throws. */
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Read one file of `workspace` (see the module comment for what is refused). */
export async function readWorkspaceFile(
  backend: FilesBackend,
  workspace: string,
  relPath: string,
): Promise<FileReadResult> {
  const refused = shapeRefusal(relPath);
  if (refused) return refused;
  let encoded: string;
  try {
    encoded = await sh(backend, READ_SCRIPT, [workspace, relPath, String(MAX_FILE_BYTES)], READ_MAX_BUFFER);
  } catch (err) {
    return refusal(err, relPath);
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
    return failure("binary", `${relPath} is a binary file`);
  }
  let content: string;
  try {
    content = strictUtf8.decode(bytes);
  } catch {
    // Saving text decoded with replacement characters would rewrite the file.
    return failure("binary", `${relPath} is not UTF-8 text`);
  }
  return { ok: true, content, hash: contentHash(content) };
}

/**
 * Write `content` to a file of `workspace`, creating it (and its folders) if
 * need be. A symlink at the path (one that stays inside) is written through.
 *
 * The content is uploaded to a temp file beside the target, then one host
 * command checks and replaces: with `expectedHash`, it hashes the file on
 * disk and answers `changed-on-disk` (with `diskHash`, or null when the file
 * is gone) unless it matches; then it renames the temp file over the target.
 * So:
 * - a reader on the host sees the old file or the new one, never half of it
 *   (the rename is atomic: the temp file is in the same folder);
 * - a change made on disk before that command runs is never overwritten; one
 *   that lands inside it, between its hash and its rename (no round trip
 *   apart), still can be;
 * - the file's permission bits are kept (`stat` on Linux and macOS); its
 *   owner, and any hard links to it, are not, as with any save-by-rename.
 * The temp file is removed whichever way the write ends, unless the host is
 * lost partway.
 */
export async function writeWorkspaceFile(
  backend: FilesBackend,
  workspace: string,
  relPath: string,
  content: string,
  expectedHash?: string,
): Promise<FileWriteResult> {
  const refused = shapeRefusal(relPath);
  if (refused) return refused;
  const expecting = expectedHash ?? "";
  try {
    await sh(backend, WRITE_PREPARE_SCRIPT, [workspace, relPath, expecting === "" ? "" : "1"]);
  } catch (err) {
    return refusal(err, relPath);
  }
  const tmpRel = posix.join(
    posix.dirname(relPath),
    `.${posix.basename(relPath)}.manor-${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    await backend.shell.writeFile(posix.join(workspace, tmpRel), Buffer.from(content, "utf-8"));
  } catch (err) {
    await backend.shell.exec("rm", ["-f", "--", posix.join(workspace, tmpRel)]).catch(() => {
      /* best effort; the upload's error is what matters */
    });
    throw err;
  }
  try {
    await sh(backend, WRITE_COMMIT_SCRIPT, [workspace, relPath, tmpRel, expecting]);
  } catch (err) {
    return refusal(err, relPath);
  }
  return { ok: true, hash: contentHash(content) };
}

/** Create an empty file (and its folders); `exists` if anything is already there. */
export async function createWorkspaceFile(
  backend: FilesBackend,
  workspace: string,
  relPath: string,
): Promise<FileWriteResult> {
  const refused = shapeRefusal(relPath);
  if (refused) return refused;
  try {
    await sh(backend, CREATE_SCRIPT, [workspace, relPath]);
  } catch (err) {
    return refusal(err, relPath);
  }
  return { ok: true, hash: contentHash("") };
}

/** `\0`-separated output as entries; a cut-off last one is dropped. */
function splitNul(output: string, cutOff: boolean): string[] {
  const parts = output.split("\0");
  // A complete listing ends in `\0`, leaving "" last; a cut-off one, a fragment.
  parts.pop();
  if (cutOff && !output.endsWith("\0")) parts.pop();
  return parts.filter((p) => p.length > 0);
}

function capped(paths: Iterable<string>, alreadyTruncated: boolean, source: FileListResult["source"]): FileListResult {
  const sorted = Array.from(new Set(paths)).sort();
  const truncated = alreadyTruncated || sorted.length > MAX_LISTED_FILES;
  return { paths: truncated ? sorted.slice(0, MAX_LISTED_FILES) : sorted, truncated, source };
}

/** A cached `git ls-files -s` entry: `<mode> <object> <stage>\t<path>`. */
const STAGED_ENTRY = /^(\d+) [0-9a-f]+ \d\t(.*)$/s;

/** Git's mode for a submodule (a gitlink): a commit, not a file to open. */
const GITLINK_MODE = "160000";

/**
 * Every file of `workspace`, relative to it: what git tracks plus what it
 * would add (gitignored files left out), less what was deleted from disk.
 * Submodules and untracked nested repos are left out: they are folders, not
 * files. So is a name with a control character in it, which `read` refuses. Outside a git repo, a walk that skips dot-folders and `node_modules`.
 */
export async function listWorkspaceFiles(backend: FilesBackend, workspace: string): Promise<FileListResult> {
  const git = (args: string[]) =>
    backend.shell.exec("git", ["-c", "core.quotePath=false", ...args], {
      cwd: workspace,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: MAX_LISTING_BYTES,
    });
  let cached: string;
  let others: string;
  try {
    [cached, others] = await Promise.all([
      git(["ls-files", "--cached", "--stage", "-z"]),
      git(["ls-files", "--others", "--exclude-standard", "-z"]),
    ]);
  } catch (err) {
    if (/not a git repository/i.test(errorMessage(err))) return walkWorkspace(backend, workspace);
    throw err;
  }
  const deleted = new Set(splitNul(await git(["ls-files", "--deleted", "-z"]).catch(() => ""), false));
  // A remote host's daemon cuts output off at `maxBuffer` rather than failing.
  const cachedCutOff = cached.length >= MAX_LISTING_BYTES;
  const othersCutOff = others.length >= MAX_LISTING_BYTES;
  const tracked = splitNul(cached, cachedCutOff).flatMap((entry) => {
    const m = STAGED_ENTRY.exec(entry);
    return m && m[1] !== GITLINK_MODE ? [m[2]] : [];
  });
  // An untracked nested repo is listed as its folder, with a trailing `/`.
  const untracked = splitNul(others, othersCutOff).filter((p) => !p.endsWith("/"));
  return capped(
    [...tracked, ...untracked].filter((p) => !deleted.has(p) && isSafeRelPath(p)),
    cachedCutOff || othersCutOff,
    "git",
  );
}

async function walkWorkspace(backend: FilesBackend, workspace: string): Promise<FileListResult> {
  // One past the cap's worth of output, so a cut-off says "truncated".
  const script = `cd -- "$1" || exit ${EXIT.noWorkspace}
find . -mindepth 1 -maxdepth ${WALK_MAX_DEPTH} \\( -type d \\( -name '.*' -o -name node_modules \\) -prune \\) -o -type f -print0 | head -c ${MAX_LISTING_BYTES}`;
  let output: string;
  try {
    output = await backend.shell.exec("sh", ["-c", script, "sh", workspace], {
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: MAX_LISTING_BYTES + 1024,
    });
  } catch (err) {
    if (exitCodeOf(err) === EXIT.noWorkspace) {
      throw new Error("The workspace folder does not exist", { cause: err });
    }
    throw err;
  }
  const cutOff = output.length >= MAX_LISTING_BYTES;
  return capped(
    splitNul(output, cutOff)
      .map((p) => p.replace(/^\.\//, ""))
      .filter(isSafeRelPath),
    cutOff,
    "walk",
  );
}
