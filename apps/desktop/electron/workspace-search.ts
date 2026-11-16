/**
 * Search a workspace's files for text, for the file pane's Search view:
 * `files.search`.
 *
 * Like `./workspace-files.ts`, everything runs through the host's
 * `ShellBackend`, never `fs` or `child_process`, so a remote host's workspace
 * is searched on its own machine exactly as a local one is. Commands are an
 * argument array (the query after `-e`, the paths after `--`), never a shell
 * string, so neither a query nor a glob is ever read by a shell.
 *
 * **Which engine.** `rg --json` when the host has `rg` on its PATH (asked once
 * per backend); else `git grep` when the workspace is in a git repo
 * (tracked files plus untracked ones, .gitignored files left out); else
 * `grep -rnI`, which skips dot-folders and `node_modules` as `files.list`'s
 * walk does. `rg` reports where each match is; for the other two the ranges
 * are found here, in JS, from the query and its flags.
 *
 * **Gaps between the engines.**
 * - Regex dialects differ: `rg` is Rust's regex, `git grep -E` and `grep -E`
 *   are POSIX ERE, and the highlighted ranges of the fallbacks come from a JS
 *   RegExp. A pattern JS cannot compile still finds its lines, highlighted
 *   from `git grep --column` (or not at all for `grep`).
 * - `rg` is given `--hidden` and skips `.git`; `git grep` sees tracked
 *   dotfiles; `grep` skips every dot-folder.
 * - Files over `MAX_FILE_BYTES` are skipped by `rg` only.
 * - `grep` filters include and exclude globs here, after the search, except
 *   a slash-free exclude, which it is also told so it can prune.
 *
 * **Globs** follow .gitignore's reading: one without a `/` matches a file or
 * folder of that name at any depth (`*.ts`, `node_modules`), one with a `/`
 * is anchored at the workspace (`src/**`, `apps/desktop`). A folder matches
 * everything in it.
 *
 * **Caps.** At most `MAX_SEARCH_MATCHES` matches, and (`rg` and `grep`) at
 * most `MAX_LINES_PER_FILE` matching lines per file; each line cut to about
 * `PREVIEW_CHARS` characters around its first match, `SEARCH_TIMEOUT_MS` and
 * `MAX_SEARCH_OUTPUT_BYTES` of output. Whatever was found before a cap hit is
 * answered, with `truncated: true`. `rg --json` ignores `--max-columns`, so a
 * very long line is bounded only by the output cap, and then by the preview.
 *
 * **Refusals.** A query with a line break, or a glob with a `..` segment, is
 * refused before anything runs. A pattern an engine cannot read is
 * `invalid-query`, told apart by the engine's own (English) words for it; a
 * search that skipped files it could not read still answers the rest. Any
 * other refusal from `git grep` (not a repo, in whatever language; a repo it
 * calls dubious; a git too old for `--column`), or no git at all, falls back
 * to `grep`. A lost connection to the host, or a workspace folder that is
 * gone, throws.
 */

import type { ShellBackend } from "./backend/types";
import { errorMessage } from "./lib/errors";
import { MAX_FILE_BYTES } from "./workspace-files";

/** At most this many matches are answered; the rest are dropped and `truncated` says so. */
export const MAX_SEARCH_MATCHES = 2000;

/** A match's line is cut to about this many characters around the match. */
export const PREVIEW_CHARS = 250;

/** A search that takes longer is stopped, and what it found so far answered. */
const SEARCH_TIMEOUT_MS = 15_000;

/** Output past this is cut off: far more than `MAX_SEARCH_MATCHES` lines need. */
const MAX_SEARCH_OUTPUT_BYTES = 16 * 1024 * 1024;

/** How much of a preview comes before its first match, when the line is cut. */
const PREVIEW_LEAD = 40;

/**
 * `rg` and `grep` stop at this many matching lines in one file, so one huge
 * file (a minified bundle, a lockfile) cannot fill the output on its own.
 * `git grep -m` is too new (2.38) to count on, so it has no such cap.
 */
export const MAX_LINES_PER_FILE = 200;

/** At most this many ranges are highlighted in one line. */
const MAX_RANGES_PER_LINE = 100;

/** The slice of a host's backend a search runs commands through. */
export type SearchBackend = { shell: Pick<ShellBackend, "exec" | "which"> };

/** What `files.search` is asked. */
export interface FileSearchParams {
  query: string;
  caseSensitive: boolean;
  /** Only matches that are whole words. */
  wholeWord: boolean;
  /** `query` is a regular expression rather than literal text. */
  regex: boolean;
  /** Only files matching one of these globs; none means every file. */
  include: string[];
  /** No file matching any of these globs. */
  exclude: string[];
  /** At most this many matches (and never more than `MAX_SEARCH_MATCHES`). */
  maxResults?: number;
}

/** Which command searched. */
export type SearchEngine = "rg" | "git-grep" | "grep";

/** One matching line. */
export interface FileSearchMatch {
  /** 1-based. */
  line: number;
  /** 1-based, in the file's line (not `text`), of the first range. */
  col: number;
  /** The line, cut to about `PREVIEW_CHARS` around the match and its indent dropped. */
  text: string;
  /** `[start, end)` character offsets of each match within `text`. */
  ranges: [number, number][];
}

/** A file's matching lines, in line order. */
export interface FileSearchFile {
  /** Relative to the workspace, `/`-separated. */
  path: string;
  matches: FileSearchMatch[];
}

/** Why a search did not run. */
export interface FileSearchFailure {
  ok: false;
  /** `invalid-query`: the engine refused the pattern (a bad regex). */
  reason: "invalid-query" | "failed";
  /** What the engine said, for the UI to show as it is. */
  message: string;
}

/** What `files.search` answers. */
export type FileSearchResult =
  | {
      ok: true;
      /** Sorted by path. */
      files: FileSearchFile[];
      /** How many matches (ranges; a line with none counts as one) are answered. */
      total: number;
      /** A cap was hit: more matches exist than are answered. */
      truncated: boolean;
      /** What searched; null for an empty query, which runs nothing. */
      engine: SearchEngine | null;
    }
  | FileSearchFailure;

// ── Globs ──

/** A glob as given, trimmed, without a leading `./` or `/` or a trailing `/`; "" when empty. */
function cleanGlob(glob: string): string {
  return glob
    .trim()
    .replace(/^\.?\/+/, "")
    .replace(/\/+$/, "");
}

function cleanGlobs(globs: string[]): string[] {
  return globs.map(cleanGlob).filter((g) => g.length > 0);
}

/** The glob and the one matching everything inside it, as a folder, in `rg --glob`'s reading. */
function rgGlobs(glob: string): string[] {
  return glob.includes("/") ? [glob, `${glob}/**`] : [glob, `**/${glob}/**`];
}

/** The same as git pathspecs, `:(glob)` anchored at the cwd. */
function gitPathspecs(glob: string, magic: "glob" | "exclude,glob"): string[] {
  const anchored = glob.includes("/") ? glob : `**/${glob}`;
  return [`:(${magic})${anchored}`, `:(${magic})${anchored}/**`];
}

/** A glob as a RegExp over a relative path, in the reading the module header gives. */
export function globToRegExp(glob: string): RegExp {
  const g = cleanGlob(glob);
  let out = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        // `**/` is any number of folders, none included; a bare `**` is anything.
        if (g[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if (c === "[") {
      const close = g.indexOf("]", i + 2);
      if (close === -1) {
        out += "\\[";
      } else {
        const body = g
          .slice(i + 1, close)
          .replace(/^!/, "^")
          .replace(/\\/g, "\\\\");
        out += `[${body}]`;
        i = close;
      }
    } else if (c === "{") {
      const close = g.indexOf("}", i);
      if (close === -1) {
        out += "\\{";
      } else {
        const alts = g
          .slice(i + 1, close)
          .split(",")
          .map((alt) =>
            alt
              .replace(/[.+^$()|\\[\]]/g, "\\$&")
              .replace(/\*/g, "[^/]*")
              .replace(/\?/g, "[^/]"),
          );
        out += `(?:${alts.join("|")})`;
        i = close;
      }
    } else {
      out += c.replace(/[.+^$()|\\{}\]]/g, "\\$&");
    }
  }
  return new RegExp(
    g.includes("/") ? `^${out}(?:/|$)` : `(?:^|/)${out}(?:/|$)`,
  );
}

/** Whether `path` is kept by `include` (any, or none given) and `exclude` (none). */
function pathFilter(
  include: string[],
  exclude: string[],
): (path: string) => boolean {
  const inc = cleanGlobs(include).map(globToRegExp);
  const exc = cleanGlobs(exclude).map(globToRegExp);
  return (path) =>
    (inc.length === 0 || inc.some((r) => r.test(path))) &&
    !exc.some((r) => r.test(path));
}

// ── Arguments ──

/** `rg`'s arguments, run in the workspace. */
export function rgArgs(p: FileSearchParams): string[] {
  const args = [
    "--json",
    "--no-config",
    "--hidden",
    "--glob",
    "!.git",
    `--max-filesize=${MAX_FILE_BYTES}`,
    `--max-count=${MAX_LINES_PER_FILE}`,
    p.caseSensitive ? "--case-sensitive" : "--ignore-case",
  ];
  if (!p.regex) args.push("--fixed-strings");
  if (p.wholeWord) args.push("--word-regexp");
  for (const g of cleanGlobs(p.include))
    for (const x of rgGlobs(g)) args.push("--glob", x);
  for (const g of cleanGlobs(p.exclude)) args.push("--glob", `!${g}`);
  // `.` rather than nothing: with no path, `rg` reads stdin when it is a pipe.
  args.push("-e", p.query, "--", ".");
  return args;
}

/** `git`'s arguments for a `git grep`, run in the workspace. */
export function gitGrepArgs(p: FileSearchParams): string[] {
  const args = [
    "-c",
    "core.quotePath=false",
    // Paths relative to the cwd, whatever the user's config says.
    "-c",
    "grep.fullName=false",
    "grep",
    "-n",
    "--column",
    "-I",
    "--null",
    "--no-color",
    "--untracked",
    "--exclude-standard",
    p.regex ? "-E" : "-F",
  ];
  if (!p.caseSensitive) args.push("-i");
  if (p.wholeWord) args.push("-w");
  args.push("-e", p.query, "--");
  const include = cleanGlobs(p.include).flatMap((g) => gitPathspecs(g, "glob"));
  args.push(...(include.length > 0 ? include : ["."]));
  for (const g of cleanGlobs(p.exclude))
    args.push(...gitPathspecs(g, "exclude,glob"));
  return args;
}

/** `grep`'s arguments, run in the workspace; globs are filtered after (see the header). */
export function grepArgs(p: FileSearchParams): string[] {
  const args = [
    "-rnI",
    "--null",
    "-m",
    String(MAX_LINES_PER_FILE),
    p.regex ? "-E" : "-F",
  ];
  if (!p.caseSensitive) args.push("-i");
  if (p.wholeWord) args.push("-w");
  // `.?*` rather than `.*`, which would skip the `.` searched.
  args.push("--exclude-dir=.?*", "--exclude-dir=node_modules");
  for (const g of cleanGlobs(p.exclude)) {
    if (!g.includes("/")) args.push(`--exclude=${g}`, `--exclude-dir=${g}`);
  }
  args.push("-e", p.query, "--", ".");
  return args;
}

// ── Ranges and previews ──

/**
 * The query as a JS RegExp, to find the ranges `git grep` and `grep` do not
 * report; null when JS cannot compile it.
 */
export function queryRegExp(
  p: Pick<FileSearchParams, "query" | "caseSensitive" | "wholeWord" | "regex">,
): RegExp | null {
  let source = p.regex
    ? p.query
    : p.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (p.wholeWord) source = `(?<!\\w)(?:${source})(?!\\w)`;
  try {
    return new RegExp(source, p.caseSensitive ? "g" : "gi");
  } catch {
    return null;
  }
}

/** Where `re` matches in `line`, empty matches left out. */
export function findRanges(line: string, re: RegExp): [number, number][] {
  const ranges: [number, number][] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while (ranges.length < MAX_RANGES_PER_LINE && (m = re.exec(line)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    ranges.push([m.index, m.index + m[0].length]);
  }
  return ranges;
}

/**
 * A match's line as shown: its indent dropped, and when long, cut to about
 * `PREVIEW_CHARS` from a little before its first range, with `…` where it was
 * cut. `ranges` are moved to match, and any wholly cut away dropped.
 */
export function preview(
  line: string,
  ranges: [number, number][],
): FileSearchMatch {
  const ws = line.length - line.trimStart().length;
  const first = ranges[0]?.[0] ?? ws;
  const indent = Math.min(ws, first);
  let start = indent;
  let end = line.length;
  if (end - start > PREVIEW_CHARS) {
    start = Math.max(
      indent,
      Math.min(first - PREVIEW_LEAD, end - PREVIEW_CHARS),
    );
    end = Math.min(end, start + PREVIEW_CHARS);
  }
  const head = start > indent ? "…" : "";
  const tail = end < line.length ? "…" : "";
  const shift = head.length - start;
  const kept: [number, number][] = [];
  for (const [s, e] of ranges) {
    const cs = Math.max(s, start);
    const ce = Math.min(e, end);
    if (ce > cs) kept.push([cs + shift, ce + shift]);
  }
  return {
    line: 0,
    col: first + 1,
    text: head + line.slice(start, end) + tail,
    ranges: kept,
  };
}

// ── Parsing ──

/** Matches as an engine reported them, before sorting and capping. */
interface Parsed {
  files: Map<string, FileSearchMatch[]>;
  total: number;
  /** More matches were found than were kept. */
  capped: boolean;
}

function newParsed(): Parsed {
  return { files: new Map(), total: 0, capped: false };
}

/** Add a line's match unless the cap is reached; null once it is. */
function add(
  out: Parsed,
  cap: number,
  path: string,
  lineNo: number,
  line: string,
  ranges: [number, number][],
): FileSearchMatch | null {
  if (out.total >= cap) {
    out.capped = true;
    return null;
  }
  // A line with more matches than are left keeps as many as are.
  if (ranges.length > cap - out.total) {
    ranges = ranges.slice(0, cap - out.total);
    out.capped = true;
  }
  const match = preview(line, ranges);
  match.line = lineNo;
  const list = out.files.get(path);
  if (list) list.push(match);
  else out.files.set(path, [match]);
  out.total += Math.max(1, ranges.length);
  return match;
}

function relative(path: string): string {
  return path.replace(/^\.\//, "");
}

/** A line without its line ending. */
function chomp(line: string): string {
  return line.replace(/\r?\n$/, "").replace(/\r$/, "");
}

type RgText = { text?: string; bytes?: string };

function rgText(value: RgText | undefined): string | null {
  return rgLine(value)?.text ?? null;
}

/** A path or line rg reported, and the bytes it came from: `bytes` (base64) when not UTF-8. */
function rgLine(
  value: RgText | undefined,
): { text: string; raw: Buffer } | null {
  if (!value) return null;
  if (typeof value.text === "string")
    return { text: value.text, raw: Buffer.from(value.text, "utf-8") };
  if (typeof value.bytes === "string") {
    const raw = Buffer.from(value.bytes, "base64");
    return { text: raw.toString("utf-8"), raw };
  }
  return null;
}

/** A byte offset into `bytes`, which decode to `text`, as a character offset of `text`. */
function charOffset(text: string, bytes: Buffer, byteOffset: number): number {
  return bytes.length === text.length
    ? byteOffset
    : bytes.subarray(0, byteOffset).toString("utf-8").length;
}

/**
 * `rg --json`'s output: its `match` messages, up to `cap` matches. A line cut
 * off at the end of the output is skipped.
 */
export function parseRgJson(output: string, cap: number): Parsed {
  const out = newParsed();
  for (const raw of output.split("\n")) {
    if (!raw.startsWith('{"type":"match"')) continue;
    let msg: {
      data?: {
        path?: RgText;
        lines?: RgText;
        line_number?: number;
        submatches?: { start: number; end: number }[];
      };
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      continue;
    }
    const data = msg.data;
    const path = rgText(data?.path);
    const reported = rgLine(data?.lines);
    if (
      !data ||
      path === null ||
      reported === null ||
      typeof data.line_number !== "number"
    )
      continue;
    const line = chomp(reported.text);
    // Offsets are into the bytes rg read: a line that is not UTF-8 maps over
    // those, not over its decoded text re-encoded.
    const bytes = reported.raw;
    const ranges = (data.submatches ?? [])
      .slice(0, MAX_RANGES_PER_LINE)
      .map(({ start, end }): [number, number] => [
        charOffset(line, bytes, Math.min(start, bytes.length)),
        charOffset(line, bytes, Math.min(end, bytes.length)),
      ])
      .filter(([s, e]) => e > s);
    if (!add(out, cap, relative(path), data.line_number, line, ranges)) break;
  }
  return out;
}

/**
 * Complete `\n`-ended lines of `output`: a cut-off last one is dropped. When
 * the output was cut short, so is the last complete-looking one: a remote
 * host's daemon ends a capped output with `\n…[truncated]`, after a record
 * it may have cut.
 */
function lines(output: string, cutShort: boolean): string[] {
  const parts = output.split("\n");
  parts.pop();
  if (cutShort) parts.pop();
  return parts;
}

/**
 * `git grep -n --column --null`'s output (`path\0line\0col\0text`), with
 * ranges found by `re`, or from the column when `re` is null.
 */
export function parseGitGrep(
  output: string,
  re: RegExp | null,
  cap: number,
  cutShort = false,
): Parsed {
  const out = newParsed();
  for (const raw of lines(output, cutShort)) {
    const a = raw.indexOf("\0");
    const b = raw.indexOf("\0", a + 1);
    const c = raw.indexOf("\0", b + 1);
    if (a <= 0 || b < 0 || c < 0) continue;
    const lineNo = Number(raw.slice(a + 1, b));
    const col = Number(raw.slice(b + 1, c));
    if (!Number.isInteger(lineNo)) continue;
    const line = chomp(raw.slice(c + 1));
    const match = add(
      out,
      cap,
      relative(raw.slice(0, a)),
      lineNo,
      line,
      re ? findRanges(line, re) : [],
    );
    if (!match) break;
    // Found by git but not by JS (a dialect gap): no highlight, but git's
    // column (a byte offset) still says where.
    if (match.ranges.length === 0 && Number.isInteger(col) && col >= 1) {
      match.col = charOffset(line, Buffer.from(line, "utf-8"), col - 1) + 1;
    }
  }
  return out;
}

/** `grep -n --null`'s output (`path\0line:text`), filtered by `keep`, with ranges found by `re`. */
export function parseGrep(
  output: string,
  re: RegExp | null,
  cap: number,
  keep: (path: string) => boolean,
  cutShort = false,
): Parsed {
  const out = newParsed();
  for (const raw of lines(output, cutShort)) {
    const a = raw.indexOf("\0");
    const colon = raw.indexOf(":", a + 1);
    if (a <= 0 || colon < 0) continue;
    const path = relative(raw.slice(0, a));
    const lineNo = Number(raw.slice(a + 1, colon));
    if (!Number.isInteger(lineNo) || !keep(path)) continue;
    const line = chomp(raw.slice(colon + 1));
    if (!add(out, cap, path, lineNo, line, re ? findRanges(line, re) : []))
      break;
  }
  return out;
}

// ── Running ──

/** How long a host found without `rg` is believed: a `which` during a reconnect answers null too. */
const RG_RECHECK_MS = 60_000;

/** Whether each backend's host has `rg`: a yes is kept, a no re-asked after `RG_RECHECK_MS`. */
const rgProbes = new WeakMap<object, { has: Promise<boolean>; at: number }>();

async function rgOn(backend: SearchBackend): Promise<boolean> {
  const known = rgProbes.get(backend.shell);
  if (known && ((await known.has) || Date.now() - known.at < RG_RECHECK_MS))
    return known.has;
  const has = backend.shell.which("rg").then(
    (path) => path !== null,
    () => false,
  );
  rgProbes.set(backend.shell, { has, at: Date.now() });
  return has;
}

/**
 * How a command ended.
 * - `output`: what it printed. Exit 1 (no matches) is empty output; a timeout
 *   or `maxBuffer` is the output so far, `cutShort`; an exit 2 over files it
 *   could not read is what it found in the rest.
 * - `refused`: it ran and said no — a bad pattern, a bad glob, an old version.
 * - `unrunnable`: it could not be started: no such command on the host, or
 *   no such folder to start it in.
 * A lost connection to the host throws.
 */
type Ran =
  | { kind: "output"; stdout: string; cutShort: boolean }
  | { kind: "refused"; failure: FileSearchFailure }
  | { kind: "unrunnable"; err: unknown };

/** The remote runner's mark on a command it stopped at its timeout (`exec-runner.ts`). */
const TIMED_OUT = /\[timed out after \d+ms\]/;

/** Each engine's words for a pattern it cannot read (rg, GNU and BSD grep, git's `command line, '…'`). */
const PATTERN_ERROR =
  /regex parse error|error parsing regex|regular expression|unmatched|not balanced|unbalanced|trailing backslash|repetition-operator|invalid (preceding|range|back ?reference|character class|content|regex)|command line, '/i;

/** A complaint about one file, which the search went past. */
const FILE_ERROR =
  /permission denied|no such file or directory|is a directory|input\/output error|operation not permitted|too many levels of symbolic links|recursive directory loop/i;

function onlyFileErrors(stderr: string): boolean {
  const complaints = stderr.split("\n").filter((l) => l.trim() !== "");
  return complaints.length > 0 && complaints.every((l) => FILE_ERROR.test(l));
}

async function run(
  backend: SearchBackend,
  cmd: string,
  args: string[],
  cwd: string,
  p: FileSearchParams,
): Promise<Ran> {
  try {
    const stdout = await backend.shell.exec(cmd, args, {
      cwd,
      timeout: SEARCH_TIMEOUT_MS,
      maxBuffer: MAX_SEARCH_OUTPUT_BYTES,
    });
    // A remote host's daemon cuts output off at `maxBuffer` rather than failing.
    return {
      kind: "output",
      stdout,
      cutShort: stdout.length >= MAX_SEARCH_OUTPUT_BYTES,
    };
  } catch (err) {
    const e = (err ?? {}) as {
      code?: unknown;
      stdout?: unknown;
      stderr?: unknown;
      killed?: unknown;
      cause?: unknown;
    };
    const stdout = typeof e.stdout === "string" ? e.stdout : "";
    const stderr = typeof e.stderr === "string" ? e.stderr : "";
    const stopped =
      e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
      // This machine's timeout: execFile killed it.
      (e.code === null && e.killed === true) ||
      // A remote host's: its runner says so.
      TIMED_OUT.test(stderr);
    if (stopped) return { kind: "output", stdout, cutShort: true };
    if (typeof e.code === "number") {
      if (e.code === 1) return { kind: "output", stdout, cutShort: false };
      const message = (stderr.trim() || errorMessage(err)).trim();
      if (p.regex && PATTERN_ERROR.test(stderr)) {
        return {
          kind: "refused",
          failure: { ok: false, reason: "invalid-query", message },
        };
      }
      if (stdout !== "" || onlyFileErrors(stderr))
        return { kind: "output", stdout, cutShort: false };
      return {
        kind: "refused",
        failure: { ok: false, reason: "failed", message },
      };
    }
    // Could not be started: `ENOENT` here; on a remote host, a null code with
    // the spawn error as stderr and no `cause` (which a lost connection has).
    if (
      e.code === "ENOENT" ||
      (e.code === null && e.cause === undefined && stderr !== "")
    ) {
      return { kind: "unrunnable", err };
    }
    throw err;
  }
}

function answer(
  parsed: Parsed,
  cutShort: boolean,
  engine: SearchEngine,
): FileSearchResult {
  const files = Array.from(parsed.files, ([path, matches]) => ({
    path,
    matches: matches.sort((a, b) => a.line - b.line),
  })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  // A file at the per-file cap may have had more (`rg` and `grep` only).
  const fileCapped =
    engine !== "git-grep" &&
    files.some((f) => f.matches.length >= MAX_LINES_PER_FILE);
  return {
    ok: true,
    files,
    total: parsed.total,
    truncated: parsed.capped || cutShort || fileCapped,
    engine,
  };
}

/** The match cap a search is held to. */
function capOf(p: FileSearchParams): number {
  const asked = p.maxResults;
  return typeof asked === "number" && Number.isFinite(asked)
    ? Math.max(1, Math.min(MAX_SEARCH_MATCHES, Math.floor(asked)))
    : MAX_SEARCH_MATCHES;
}

/** A query or glob refused before anything runs. */
function badParams(p: FileSearchParams): FileSearchFailure | null {
  if (/[\r\n]/.test(p.query)) {
    return {
      ok: false,
      reason: "invalid-query",
      message:
        "Search looks within one line: the query cannot hold a line break",
    };
  }
  const leaving = [...p.include, ...p.exclude].find((g) =>
    cleanGlob(g).split("/").includes(".."),
  );
  if (leaving !== undefined) {
    return {
      ok: false,
      reason: "invalid-query",
      message: `${leaving.trim()} leaves the workspace`,
    };
  }
  return null;
}

/**
 * Search `workspace` on its host for `params.query`. An empty query answers
 * nothing without running anything; a pattern the engine refuses, a query
 * with a line break or a glob with `..` answers `invalid-query`. A workspace
 * folder that is gone, or a host that is away, throws.
 */
export async function searchWorkspace(
  backend: SearchBackend,
  workspace: string,
  params: FileSearchParams,
): Promise<FileSearchResult> {
  if (params.query === "")
    return { ok: true, files: [], total: 0, truncated: false, engine: null };
  const bad = badParams(params);
  if (bad) return bad;
  const cap = capOf(params);

  if (await rgOn(backend)) {
    const ran = await run(backend, "rg", rgArgs(params), workspace, params);
    if (ran.kind === "unrunnable") throw ran.err;
    if (ran.kind === "refused") return ran.failure;
    return answer(parseRgJson(ran.stdout, cap), ran.cutShort, "rg");
  }

  const re = queryRegExp(params);
  // Any other refusal — not a repo, in any language; a repo git calls
  // dubious; a git too old for `--column` — and no git at all, go to grep.
  const git = await run(backend, "git", gitGrepArgs(params), workspace, params);
  if (git.kind === "output") {
    return answer(
      parseGitGrep(git.stdout, re, cap, git.cutShort),
      git.cutShort,
      "git-grep",
    );
  }
  if (git.kind === "refused" && git.failure.reason === "invalid-query")
    return git.failure;

  const ran = await run(backend, "grep", grepArgs(params), workspace, params);
  if (ran.kind === "unrunnable") throw ran.err;
  if (ran.kind === "refused") return ran.failure;
  return answer(
    parseGrep(
      ran.stdout,
      re,
      cap,
      pathFilter(params.include, params.exclude),
      ran.cutShort,
    ),
    ran.cutShort,
    "grep",
  );
}
