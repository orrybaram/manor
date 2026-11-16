import type { FileSearchFile, FileSearchParams, FileSearchResult } from "../../../electron.d";

/**
 * Go to Definition without a language server: one regex for the shapes a
 * definition takes in common languages, run through `files.search` over the
 * workspace, and a ranker that picks the likeliest hit.
 *
 * The pattern runs on whichever engine the host has (`rg`'s Rust regex, or
 * POSIX ERE for `git grep -E` and `grep -E`), and the fallbacks highlight
 * with a JS RegExp of it, so it uses only what all four read the same:
 * groups, `|`, `?`, `*`, `+`, `^`, `$` and bracket classes of plain
 * characters. No `\b`, `\s`, `\w`, lookarounds or escapes: a literal
 * character is put in brackets (`[(]`, `[$]`), and blanks are `[ <tab>]`.
 * Nor a carriage return, which `files.search` refuses in a query: where a
 * line must end, anything but code may follow (a CRLF file's `\r`, a `}`).
 *
 * It finds, for an identifier X:
 * - declarations: `class|interface|enum|struct|trait|def|defp|fn|fun|
 *   module|mod|namespace X`, `type X` with something after it (`=`, `<`,
 *   `{` or a word: not a multi-line import's `type X,`), `function X` / `function* X`, `func X` and Go's
 *   `func (r T) X`, and `const|let|var|val X =` (with a type, or Rust's `mut`).
 *   Whatever comes before (`export default`, `pub`, `async`) doesn't matter.
 * - assignments of a function: `X = (…) =>`, `X: function`, `this.X = async x =>`.
 * - method heads: a line that starts with X (after modifiers such as `static
 *   async` or a return type) and its closed parameter list, and ends with
 *   `{` (a call opening an object argument, `x({`, doesn't close its list).
 *
 * A method head can't be told from a call at the start of a line that opens
 * a block (`describe("x", () => {`), nor any line from one in a comment, so
 * the ranker drops those afterwards, in JS.
 */

/** A name Go to Definition looks for: one identifier, as most languages spell it. */
export const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function isIdentifier(word: string): boolean {
  return IDENTIFIER.test(word);
}

/** Blanks: a space or a tab (a real tab: `\t` in brackets is two characters to POSIX). */
const SP = "[ \t]";
/** A character that can't be part of an identifier. */
const NOT_WORD = "[^A-Za-z0-9_$]";
/** Where an identifier may end: before a non-identifier character, or at the end of the line. */
const END = `(${NOT_WORD}|$)`;
/** Where a keyword may start: not inside a word, nor after a `.` (`obj.type x`). */
const KEYWORD_START = "(^|[^A-Za-z0-9_$.])";

const DECLARATION_KEYWORDS = [
  "class",
  "interface",
  "enum",
  "struct",
  "trait",
  "def",
  "defp",
  "fn",
  "fun",
  "module",
  "mod",
  "namespace",
];

/** Where a line ends: nothing but blanks, a CR or punctuation, never a word or `;`. */
const LINE_END = "[^A-Za-z0-9_$;]*$";

/** `X` as a pattern: every character as itself (`$` in brackets). */
function literal(word: string): string {
  return word.replace(/\$/g, "[$]");
}

/** What kind of definition a line looks like; the ranker trusts them in this order. */
export type DefinitionKind = "declaration" | "assignment" | "method";

/** Each shape's pattern for `word`, by the kind of definition it finds. */
function shapes(word: string): { kind: DefinitionKind; source: string }[] {
  const x = literal(word);
  return [
    {
      kind: "declaration",
      source: `${KEYWORD_START}(${DECLARATION_KEYWORDS.join("|")})${SP}+${x}${END}`,
    },
    {
      kind: "declaration",
      source: `${KEYWORD_START}type${SP}+${x}(${SP}*[=<{]|${SP}+[A-Za-z_*(])`,
    },
    { kind: "declaration", source: `${KEYWORD_START}function(${SP}*[*]${SP}*|${SP}+)${x}${END}` },
    { kind: "declaration", source: `${KEYWORD_START}func(${SP}+|${SP}*[(][^)]*[)]${SP}*)${x}${END}` },
    {
      kind: "declaration",
      source: `${KEYWORD_START}(const|let|var|val)${SP}+(mut${SP}+)?${x}${SP}*(:[^=]*)?=([^=]|$)`,
    },
    {
      kind: "assignment",
      source:
        `(^|${NOT_WORD})${x}${SP}*[:=]${SP}*(async${SP}+)?` +
        `(function|[(][^)]*[)]${SP}*(:[^=]*)?=>|[A-Za-z_$][A-Za-z0-9_$]*${SP}*=>)`,
    },
    {
      kind: "method",
      source:
        `^${SP}*([A-Za-z_$][A-Za-z0-9_$<>,.]*${SP}+)*[*]?${SP}*${x}${SP}*(<[^>]*>)?${SP}*` +
        `[(][^;]*[)][^;(]*[{]${LINE_END}`,
    },
  ];
}

/**
 * The one pattern `files.search` is asked (regex, case-sensitive) for the
 * definitions of `word`, which must be an identifier.
 */
export function definitionPattern(word: string): string {
  if (!isIdentifier(word)) throw new Error(`Not an identifier: ${word}`);
  return shapes(word)
    .map((s) => `(${s.source})`)
    .join("|");
}

/** What `files.search` is asked for `word`'s definitions. */
export function definitionSearch(word: string): FileSearchParams {
  return {
    query: definitionPattern(word),
    caseSensitive: true,
    wholeWord: false,
    regex: true,
    include: [],
    exclude: [],
    maxResults: 500,
  };
}

/** One likely definition. */
export type DefinitionHit = {
  path: string;
  /** 1-based. */
  line: number;
  /** 1-based, on the identifier when it can be placed, else where the match starts. */
  col: number;
  text: string;
  /** Where the identifier is in `text`, when it can be placed. */
  name: [number, number] | null;
  kind: DefinitionKind;
  score: number;
};

/** A line that is a comment, by how it starts (its indent already dropped). */
const COMMENT = /^(\/\/|\/\*|\*|#|--|<!--|;)/;
/** A line that brings a name in rather than defining it. */
const IMPORT = /^(import|from|use|using|require|include|export\s*(\*|\{))(?![A-Za-z0-9_$])/;
/** A multi-line import's `type X as Y,`. */
const TYPE_AS = /^type\s+[A-Za-z0-9_$]+\s+as\s/;
/** Words before a "method head" that make it a statement: a call, not a definition. */
const STATEMENT =
  /(^|[^A-Za-z0-9_$])(return|await|yield|new|throw|else|if|while|for|switch|case|typeof|delete|do|in|of)\s/;

/** Where a file is unlikely to hold the definition you meant. */
const UNLIKELY_FILE = [
  /(^|\/)node_modules\//,
  /(^|\/)(vendor|dist|build|out)\//,
  /\.d\.ts$/,
  /(^|\/)(__tests__|__mocks__|tests?|spec|e2e|fixtures?)\//,
  /\.(test|spec|stories)\.[^/]+$/,
  /_test\.(go|py)$/,
  /(^|\/)test_[^/]+\.py$/,
];

export function isUnlikelyFile(path: string): boolean {
  return UNLIKELY_FILE.some((re) => re.test(path));
}

const KIND_WEIGHT: Record<DefinitionKind, number> = {
  declaration: 2,
  assignment: 2,
  method: 1,
};

/**
 * `files`' lines that look like definitions of `word`, best first: one in
 * `currentPath` (the open file), then outside tests, vendored code and type
 * declarations, then declarations and assignments over method heads.
 * Comments, imports and call-like method heads are dropped, and a line
 * reported twice is kept once.
 */
export function rankDefinitions(
  word: string,
  files: FileSearchFile[],
  currentPath: string | null = null,
): DefinitionHit[] {
  const compiled = shapes(word).map((s) => ({ kind: s.kind, re: new RegExp(s.source) }));
  const name = new RegExp(`(^|[^A-Za-z0-9_$])${word.replace(/\$/g, "\\$")}(?![A-Za-z0-9_$])`);
  const seen = new Set<string>();
  const hits: DefinitionHit[] = [];
  for (const file of files) {
    for (const match of file.matches) {
      const key = `${file.path}:${match.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const text = match.text.replace(/^…/, "");
      const trimmed = text.trimStart();
      if (COMMENT.test(trimmed) || IMPORT.test(trimmed) || TYPE_AS.test(trimmed)) continue;
      const shape = compiled.find((s) => s.re.test(text));
      if (!shape) continue;
      const m = shape.re.exec(text)!;
      if (shape.kind === "method") {
        const head = m[0].slice(0, Math.max(0, nameIndex(m[0], name)));
        if (/=>|function/.test(m[0]) || STATEMENT.test(` ${head}`)) continue;
      }
      const at = nameIndex(m[0], name);
      const start = at < 0 ? null : m.index + (match.text.startsWith("…") ? 1 : 0) + at;
      // A method head in the open file may be its own call: only a sure
      // definition there beats the rest of the workspace.
      const here = currentPath !== null && file.path === currentPath && shape.kind !== "method";
      hits.push({
        path: file.path,
        line: match.line,
        col: identifierCol(match, start),
        text: match.text,
        name: start === null ? null : [start, start + word.length],
        kind: shape.kind,
        score:
          (here ? 100 : 0) +
          (isUnlikelyFile(file.path) ? 0 : 10) +
          KIND_WEIGHT[shape.kind],
      });
    }
  }
  return hits.sort(
    (a, b) =>
      b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.line - b.line,
  );
}

/** Where `name` starts in `s`: past the character before it, if one matched. */
function nameIndex(s: string, name: RegExp): number {
  const m = name.exec(s);
  if (!m) return -1;
  return m.index + m[1].length;
}

/**
 * The file column of the identifier at `start` in `match.text`: the first
 * highlighted range ties the text's offsets to the file's. Without a range,
 * where the match starts.
 */
function identifierCol(
  match: { col: number; ranges: [number, number][] },
  start: number | null,
): number {
  const first = match.ranges[0];
  if (!first || start === null) return match.col;
  return Math.max(1, match.col + (start - first[0]));
}

/** The hits that tie for the best score: the ones "Definitions of X" lists. */
export function topTier(hits: DefinitionHit[]): DefinitionHit[] {
  return hits.filter((h) => h.score === hits[0]?.score);
}

/**
 * `hits` as the Search view's file groups, in their order, each line
 * highlighting just the name (or nothing, where it couldn't be placed).
 */
export function definitionGroups(hits: DefinitionHit[]): FileSearchFile[] {
  const groups: FileSearchFile[] = [];
  const byPath = new Map<string, FileSearchFile>();
  for (const hit of hits) {
    let group = byPath.get(hit.path);
    if (!group) {
      group = { path: hit.path, matches: [] };
      byPath.set(hit.path, group);
      groups.push(group);
    }
    group.matches.push({
      line: hit.line,
      col: hit.col,
      text: hit.text,
      ranges: hit.name ? [hit.name] : [],
    });
  }
  return groups;
}

/** What Go to Definition does with what it found. */
export type DefinitionOutcome =
  | { kind: "none" }
  | { kind: "one"; hit: DefinitionHit }
  | { kind: "several"; hits: DefinitionHit[] };

/**
 * One hit, or one that outranks the rest, is opened; several equally likely
 * ones are listed; none is said so.
 */
export function pickDefinition(hits: DefinitionHit[]): DefinitionOutcome {
  if (hits.length === 0) return { kind: "none" };
  if (hits.length === 1 || hits[0].score > hits[1].score) return { kind: "one", hit: hits[0] };
  return { kind: "several", hits };
}

/**
 * Search for `word`'s definitions and decide what to do with them. A search
 * that fails comes back as it was answered, for the caller to report.
 */
export async function findDefinition(
  word: string,
  search: (params: FileSearchParams) => Promise<FileSearchResult>,
  currentPath: string | null,
): Promise<DefinitionOutcome | Extract<FileSearchResult, { ok: false }>> {
  const result = await search(definitionSearch(word));
  if (!result.ok) return result;
  return pickDefinition(rankDefinitions(word, result.files, currentPath));
}
