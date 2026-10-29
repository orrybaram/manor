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

import { createHash } from "node:crypto";
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
  /** Nothing at the path (read, or a write's `expectedHash` check). */
  | "not-found"
  /** Something at the path, but not a regular file (a directory). */
  | "not-a-file"
  /** Over `MAX_FILE_BYTES`; `size` says by how much. */
  | "too-large"
  /** A NUL byte in its first `BINARY_SNIFF_BYTES`, or not UTF-8. */
  | "binary"
  /** `write` with an `expectedHash` the file on disk no longer has. */
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
  if (relPath.length === 0 || relPath.includes("\0") || relPath.includes("\\")) return false;
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
  binary: 15,
  exists: 16,
} as const;

/**
 * Sets `root` (the workspace's physical path) and `f` (the target), and exits
 * `outside` unless the target's nearest existing directory, and a symlink at
 * the target, resolve under `root`.
 */
const CONTAIN = `
root=$(cd -P -- "$1" 2>/dev/null && pwd -P) || exit ${EXIT.noWorkspace}
f="$1/$2"
p=$(dirname -- "$f")
while [ ! -d "$p" ]; do p=$(dirname -- "$p"); done
d=$(cd -P -- "$p" 2>/dev/null && pwd -P) || exit ${EXIT.outside}
case "$d/" in "$root"/*) ;; *) exit ${EXIT.outside} ;; esac
if [ -L "$f" ]; then
  t=$(readlink -f -- "$f" 2>/dev/null || realpath -- "$f" 2>/dev/null) || exit ${EXIT.outside}
  case "$t/" in "$root"/*) ;; *) exit ${EXIT.outside} ;; esac
fi
`;

/** Contain, refuse what is missing, too large or binary, then print it. */
const READ_SCRIPT = `${CONTAIN}
[ -e "$f" ] || exit ${EXIT.notFound}
[ -f "$f" ] || exit ${EXIT.notAFile}
size=$(wc -c < "$f" | tr -d ' ')
if [ "$size" -gt "$3" ]; then echo "$size"; exit ${EXIT.tooLarge}; fi
all=$(head -c ${BINARY_SNIFF_BYTES} "$f" | wc -c | tr -d ' ')
text=$(head -c ${BINARY_SNIFF_BYTES} "$f" | tr -d '\\000' | wc -c | tr -d ' ')
[ "$all" -eq "$text" ] || exit ${EXIT.binary}
cat -- "$f"
`;

/** Contain, and refuse a directory where a file is to be written. */
const WRITE_CHECK_SCRIPT = `${CONTAIN}
if [ -e "$f" ] && [ ! -f "$f" ]; then exit ${EXIT.notAFile}; fi
exit 0
`;

/** Contain, then make an empty file, failing if anything is already there. */
const CREATE_SCRIPT = `${CONTAIN}
if [ -e "$f" ] || [ -L "$f" ]; then exit ${EXIT.exists}; fi
mkdir -p -- "$(dirname -- "$f")" || exit 1
( set -C; : > "$f" ) 2>/dev/null || exit ${EXIT.exists}
`;

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
    case EXIT.binary:
      return failure("binary", `${relPath} is a binary file`);
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

/** Read one file of `workspace` (see the module comment for what is refused). */
export async function readWorkspaceFile(
  backend: FilesBackend,
  workspace: string,
  relPath: string,
): Promise<FileReadResult> {
  const refused = shapeRefusal(relPath);
  if (refused) return refused;
  let content: string;
  try {
    // Room for the file and a little: the size check already ran.
    content = await sh(backend, READ_SCRIPT, [workspace, relPath, String(MAX_FILE_BYTES)], MAX_FILE_BYTES + 64 * 1024);
  } catch (err) {
    return refusal(err, relPath);
  }
  // Bytes that are not UTF-8 came back as U+FFFD; saving them would rewrite
  // the file. Treated as binary.
  if (content.includes("�")) return failure("binary", `${relPath} is not UTF-8 text`);
  return { ok: true, content, hash: contentHash(content) };
}

/**
 * Write `content` to a file of `workspace`, creating it (and its folders) if
 * need be. With `expectedHash`, a file whose content no longer hashes to it —
 * or that is gone — is left alone and `changed-on-disk` answered instead.
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
  if (expectedHash !== undefined) {
    const current = await readWorkspaceFile(backend, workspace, relPath);
    if (current.ok && current.hash !== expectedHash) {
      return failure("changed-on-disk", `${relPath} changed on disk`, { diskHash: current.hash });
    }
    if (!current.ok && current.reason === "not-found") {
      return failure("changed-on-disk", `${relPath} was deleted on disk`, { diskHash: null });
    }
    if (!current.ok) return current;
  } else {
    try {
      await sh(backend, WRITE_CHECK_SCRIPT, [workspace, relPath]);
    } catch (err) {
      return refusal(err, relPath);
    }
  }
  await backend.shell.writeFile(posix.join(workspace, relPath), Buffer.from(content, "utf-8"));
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

/**
 * Every file of `workspace`, relative to it: what git tracks plus what it
 * would add (gitignored files left out), less what was deleted from disk.
 * Outside a git repo, a walk that skips dot-folders and `node_modules`.
 */
export async function listWorkspaceFiles(backend: FilesBackend, workspace: string): Promise<FileListResult> {
  const git = (args: string[]) =>
    backend.shell.exec("git", ["-c", "core.quotePath=false", ...args], {
      cwd: workspace,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: MAX_LISTING_BYTES,
    });
  let listing: string;
  try {
    listing = await git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  } catch (err) {
    if (/not a git repository/i.test(errorMessage(err))) return walkWorkspace(backend, workspace);
    throw err;
  }
  const deleted = new Set(splitNul(await git(["ls-files", "--deleted", "-z"]).catch(() => ""), false));
  // A remote host's daemon cuts output off at `maxBuffer` rather than failing.
  const cutOff = listing.length >= MAX_LISTING_BYTES;
  return capped(
    splitNul(listing, cutOff).filter((p) => !deleted.has(p)),
    cutOff,
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
    splitNul(output, cutOff).map((p) => p.replace(/^\.\//, "")),
    cutOff,
    "walk",
  );
}
