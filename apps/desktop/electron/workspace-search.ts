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
 * **Caps.** At most `MAX_SEARCH_MATCHES` matches, each line cut to about
 * `PREVIEW_CHARS` characters around its first match, `SEARCH_TIMEOUT_MS` and
 * `MAX_SEARCH_OUTPUT_BYTES` of output; whatever was found before a cap hit is
 * answered, with `truncated: true`.
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
  const args = ["-rnI", "--null", p.regex ? "-E" : "-F"];
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
  if (!value) return null;
  if (typeof value.text === "string") return value.text;
  if (typeof value.bytes === "string")
    return Buffer.from(value.bytes, "base64").toString("utf-8");
  return null;
}

/** A UTF-8 byte offset into `text` as a character offset. */
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
    const text = rgText(data?.lines);
    if (
      !data ||
      path === null ||
      text === null ||
      typeof data.line_number !== "number"
    )
      continue;
    const line = chomp(text);
    const bytes = Buffer.from(line, "utf-8");
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

/** Complete `\n`-ended lines of `output`: a cut-off last one is dropped. */
function lines(output: string): string[] {
  const parts = output.split("\n");
  parts.pop();
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
): Parsed {
  const out = newParsed();
  for (const raw of lines(output)) {
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
): Parsed {
  const out = newParsed();
  for (const raw of lines(output)) {
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

/** Whether each backend's host has `rg`, asked once. */
const hasRg = new WeakMap<object, Promise<boolean>>();

function rgOn(backend: SearchBackend): Promise<boolean> {
  let known = hasRg.get(backend.shell);
  if (!known) {
    known = backend.shell.which("rg").then(
      (path) => path !== null,
      () => false,
    );
    hasRg.set(backend.shell, known);
  }
  return known;
}

/** What a finished (or stopped) command left: its output, and whether it was cut short. */
type Ran = { stdout: string; cutShort: boolean } | { failed: unknown };

/**
 * Run `cmd`. Exit 1 is "no matches"; a timeout or `maxBuffer` is the output
 * so far, cut short; any other failure with output (a file it could not read)
 * is still its output. A failure without output is `failed`.
 */
async function run(
  backend: SearchBackend,
  cmd: string,
  args: string[],
  cwd: string,
): Promise<Ran> {
  try {
    const stdout = await backend.shell.exec(cmd, args, {
      cwd,
      timeout: SEARCH_TIMEOUT_MS,
      maxBuffer: MAX_SEARCH_OUTPUT_BYTES,
    });
    // A remote host's daemon cuts output off at `maxBuffer` rather than failing.
    return { stdout, cutShort: stdout.length >= MAX_SEARCH_OUTPUT_BYTES };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: unknown } | null;
    const stdout = typeof e?.stdout === "string" ? e.stdout : "";
    if (e?.code === 1 && stdout === "") return { stdout: "", cutShort: false };
    const stopped =
      e?.code === null || e?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
    if (stopped) return { stdout, cutShort: true };
    if (stdout !== "") return { stdout, cutShort: false };
    return { failed: err };
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
  return {
    ok: true,
    files,
    total: parsed.total,
    truncated: parsed.capped || cutShort,
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

/**
 * Search `workspace` on its host for `params.query`. An empty query answers
 * nothing without running anything; a pattern the engine refuses answers
 * `invalid-query`. A workspace folder that is gone, or a host that is away,
 * throws.
 */
export async function searchWorkspace(
  backend: SearchBackend,
  workspace: string,
  params: FileSearchParams,
): Promise<FileSearchResult> {
  if (params.query === "")
    return { ok: true, files: [], total: 0, truncated: false, engine: null };
  const cap = capOf(params);

  if (await rgOn(backend)) {
    const ran = await run(backend, "rg", rgArgs(params), workspace);
    if ("failed" in ran) return failedOrThrow(ran.failed, params);
    return answer(parseRgJson(ran.stdout, cap), ran.cutShort, "rg");
  }

  const re = queryRegExp(params);
  const git = await run(backend, "git", gitGrepArgs(params), workspace);
  if (!("failed" in git))
    return answer(parseGitGrep(git.stdout, re, cap), git.cutShort, "git-grep");
  const why =
    errorMessage(git.failed) +
    String((git.failed as { stderr?: unknown } | null)?.stderr ?? "");
  const noGit = (git.failed as { code?: unknown } | null)?.code === "ENOENT";
  if (!noGit && !/not a git repository/i.test(why))
    return failedOrThrow(git.failed, params);

  const ran = await run(backend, "grep", grepArgs(params), workspace);
  if ("failed" in ran) return failedOrThrow(ran.failed, params);
  return answer(
    parseGrep(ran.stdout, re, cap, pathFilter(params.include, params.exclude)),
    ran.cutShort,
    "grep",
  );
}

/** A command that ran and refused is an answer; one that could not run (no workspace) throws. */
function failedOrThrow(err: unknown, p: FileSearchParams): FileSearchFailure {
  const { code, stderr } = (err ?? {}) as { code?: unknown; stderr?: unknown };
  if (typeof code !== "number") throw err;
  const message = (
    (typeof stderr === "string" && stderr.trim()) ||
    errorMessage(err)
  ).trim();
  // Each engine exits 2 (git, 128) on a pattern it cannot read; a literal one it always can.
  return { ok: false, reason: p.regex ? "invalid-query" : "failed", message };
}
