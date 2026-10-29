/**
 * File paths in a line of terminal output, and where they lead in a
 * workspace. Pure: the link provider asks the workspace's file listing which
 * of these exist.
 */

/** One path printed on a line, with the line and column it may name. */
export type FilePathMatch = {
  /** The path as printed, without its `:line:col`. */
  path: string;
  line?: number;
  col?: number;
  /** Where the link starts on the line: an index into the string, 0-based. */
  start: number;
  /** Just past where it ends, `:line:col` included. */
  end: number;
};

/**
 * A path, then an optional `:line[:col]` or tsc's `(line,col)`.
 *
 * Not preceded by anything a path or URL is made of, so the tail of
 * `https://host/a.js` or `a:b/c.ts` is not one. The path never takes a `:`,
 * so `src/foo.ts:12` splits there, and it ends on a word character, so a
 * sentence's full stop is left off.
 */
const PATH_RE =
  /(?<![\w@.+\-/:~\\])((?:\.{1,2}\/|\/)?[\w@.+-][\w@.+\-/]*[\w])(?::(\d+)(?::(\d+))?|\((\d+),(\d+)\))?/g;

/** An extension: what a path with no slash needs to count. */
const HAS_EXTENSION = /\.[A-Za-z0-9]+$/;

/**
 * Every path-shaped run on `line`: one with a `/`, or one with a file
 * extension (`README.md`). Most are not files; the caller checks.
 */
export function matchFilePaths(line: string): FilePathMatch[] {
  const matches: FilePathMatch[] = [];
  PATH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PATH_RE.exec(line)) !== null) {
    const path = m[1];
    if (!path.includes("/") && !HAS_EXTENSION.test(path)) continue;
    // `//host/x` is a protocol-relative URL, not a path.
    if (path.startsWith("//")) continue;
    const lineNum = m[2] ?? m[4];
    const colNum = m[3] ?? m[5];
    matches.push({
      path,
      ...(lineNum ? { line: Number(lineNum) } : {}),
      ...(colNum ? { col: Number(colNum) } : {}),
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return matches;
}

/** `/a/b/../c/./d` → `/a/c/d`; null when `..` climbs past the root. */
function normalizeAbsolute(path: string): string | null {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(part);
  }
  return `/${out.join("/")}`;
}

/** `printed` resolved against `base`, as a path relative to `root`; null outside it. */
function relativeTo(printed: string, base: string, root: string): string | null {
  const abs = normalizeAbsolute(printed.startsWith("/") ? printed : `${base}/${printed}`);
  const top = normalizeAbsolute(root);
  if (!abs || !top) return null;
  if (top === "/") return abs === "/" ? null : abs.slice(1);
  if (!abs.startsWith(`${top}/`)) return null;
  return abs.slice(top.length + 1);
}

/**
 * Where a printed path may be in the workspace at `root`, most likely first:
 * against the terminal's `cwd` when it knows one, then against the root
 * (agents print paths from the repo's top whatever the shell's cwd). An
 * absolute path has one answer, or none when it is outside the workspace.
 * Workspace-relative, `/`-separated.
 */
export function workspaceCandidates(
  printed: string,
  cwd: string | null | undefined,
  root: string,
): string[] {
  if (printed.startsWith("/")) {
    const rel = relativeTo(printed, root, root);
    return rel ? [rel] : [];
  }
  const out: string[] = [];
  for (const base of cwd ? [cwd, root] : [root]) {
    const rel = relativeTo(printed, base, root);
    if (rel && !out.includes(rel)) out.push(rel);
  }
  return out;
}
