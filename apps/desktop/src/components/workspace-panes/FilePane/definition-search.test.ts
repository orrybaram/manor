import { describe, expect, it, vi } from "vitest";
import type { FileSearchFile, FileSearchMatch } from "../../../electron.d";
import {
  definitionPattern,
  definitionSearch,
  findDefinition,
  isIdentifier,
  isUnlikelyFile,
  pickDefinition,
  rankDefinitions,
} from "./definition-search";

/** Whether `line` matches the definition pattern for `word`, read as a JS RegExp. */
const matches = (word: string, line: string) => new RegExp(definitionPattern(word)).test(line);

/** A match as `files.search` answers it: the line's indent dropped, the whole pattern's range. */
function hit(line: number, raw: string, word = "fooBar"): FileSearchMatch {
  const indent = raw.length - raw.trimStart().length;
  const text = raw.trimStart();
  const m = new RegExp(definitionPattern(word)).exec(text);
  const ranges: [number, number][] = m ? [[m.index, m.index + m[0].length]] : [];
  return { line, col: indent + (ranges[0]?.[0] ?? 0) + 1, text, ranges };
}

const file = (path: string, ...lines: [number, string][]): FileSearchFile => ({
  path,
  matches: lines.map(([n, l]) => hit(n, l)),
});

describe("isIdentifier", () => {
  it("takes one identifier and nothing else", () => {
    for (const w of ["foo", "_foo", "$foo", "foo$bar", "Foo1", "_"]) expect(isIdentifier(w)).toBe(true);
    for (const w of ["", "1foo", "foo-bar", "foo.bar", "foo bar", "é", "foo("]) {
      expect(isIdentifier(w)).toBe(false);
    }
  });
});

describe("definitionPattern", () => {
  it("refuses what isn't an identifier", () => {
    expect(() => definitionPattern("a.b")).toThrow();
    expect(() => definitionPattern("")).toThrow();
  });

  it("uses only what rg, POSIX ERE and JS read the same", () => {
    const p = definitionPattern("fo$o");
    // No backslash escapes, no \b/\s/\w, no lookarounds.
    expect(p).not.toMatch(/\\/);
    expect(p).not.toMatch(/\(\?/);
    expect(p).not.toContain("\n");
    // `$` in the name is a literal, in brackets.
    expect(p).toContain("fo[$]o");
  });

  it("is asked case-sensitively, as a regex, capped", () => {
    expect(definitionSearch("fooBar")).toEqual({
      query: definitionPattern("fooBar"),
      caseSensitive: true,
      wholeWord: false,
      regex: true,
      include: [],
      exclude: [],
      maxResults: 500,
    });
  });

  it.each([
    // TS / JS
    "export function fooBar(a: number) {}",
    "function fooBar() {",
    "export default function* fooBar() {}",
    "async function *fooBar() {",
    "export const fooBar = (a) => a;",
    "const fooBar = 1;",
    "let fooBar: Map<string, number> = new Map();",
    "var fooBar=2",
    "export class fooBar extends Base {}",
    "export abstract class fooBar {",
    "export interface fooBar {}",
    "export type fooBar<T> = T;",
    "enum fooBar { A }",
    "namespace fooBar {",
    "  fooBar = async (x) => x;",
    "  fooBar: function () {},",
    "  this.fooBar = y => y;",
    "module.exports.fooBar = function () {",
    "  public static async fooBar(a: string): Promise<void> {",
    "  *fooBar() {",
    "  fooBar<T>(a: T) {",
    "  get fooBar() {",
    // Python
    "def fooBar(x):",
    "    async def fooBar(self):",
    "class fooBar(Base):",
    // Go
    "func fooBar() {}",
    "func (r *T) fooBar(x int) error {",
    "type fooBar struct {}",
    // Rust
    "pub fn fooBar() {}",
    "pub(crate) fn fooBar<T>(x: T) -> T {",
    "let mut fooBar = 1;",
    "pub struct fooBar;",
    "trait fooBar {",
    "\tfn\tfooBar() {}",
    // Kotlin, Elixir, C-likes
    "fun fooBar(): Int {",
    "val fooBar = 3",
    "defp fooBar(x), do: x",
    "int fooBar(void) {",
  ])("finds %j", (line) => {
    expect(matches("fooBar", line)).toBe(true);
  });

  it.each([
    "fooBar(1);",
    "const x = fooBar(2);",
    "return fooBar;",
    "fooBar.baz = 1",
    "const fooBarBaz = 1;",
    "function fooBarBaz() {}",
    "function xfooBar() {}",
    "class FooBar {}",
    "if (fooBar == (a)) {}",
    "for (const fooBar of xs) {}",
    "obj.function fooBar",
    "  fooBar(a, b);",
    "  x.fooBar(a) {",
    "  fooBar(a); {",
    "const fooBar == 1",
  ])("leaves %j", (line) => {
    expect(matches("fooBar", line)).toBe(false);
  });

  it("reads `$` in a name as itself", () => {
    expect(matches("$el", "const $el = 1;")).toBe(true);
    expect(matches("$el", "const xel = 1;")).toBe(false);
    expect(matches("a$", "function a$() {}")).toBe(true);
    expect(matches("a$", "function a() {}")).toBe(false);
  });
});

describe("rankDefinitions", () => {
  it("drops comments, imports and call-like method heads", () => {
    const hits = rankDefinitions("fooBar", [
      file(
        "src/a.ts",
        [1, "// function fooBar is below"],
        [2, " * class fooBar does things"],
        [3, "# def fooBar"],
        [4, 'import type fooBar from "./x";'],
        [5, "export { fooBar } from './y';"],
        [6, '  fooBar("x", () => {'],
        [7, "  return fooBar(x) {"],
        [8, "  await fooBar(function () {"],
        [9, "export function fooBar() {"],
      ),
    ]);
    expect(hits.map((h) => h.line)).toEqual([9]);
  });

  it("keeps a line reported twice once", () => {
    const hits = rankDefinitions("fooBar", [
      file("src/a.ts", [3, "function fooBar() {"], [3, "function fooBar() {"]),
    ]);
    expect(hits).toHaveLength(1);
  });

  it("puts the open file first, then source over tests, vendored code and .d.ts, then declarations over method heads", () => {
    const files = [
      file("node_modules/x/index.js", [1, "function fooBar() {}"]),
      file("src/types.d.ts", [1, "export declare function fooBar(): void;"]),
      file("src/a.test.ts", [1, "function fooBar() {}"]),
      file("src/cls.ts", [4, "  fooBar(a) {"]),
      file("src/b.ts", [2, "export const fooBar = () => 1;"]),
      file("src/open.ts", [9, "  fooBar(a) {"]),
    ];
    const hits = rankDefinitions("fooBar", files, "src/open.ts");
    expect(hits.map((h) => h.path)).toEqual([
      "src/open.ts",
      "src/b.ts",
      "src/cls.ts",
      "node_modules/x/index.js",
      "src/a.test.ts",
      "src/types.d.ts",
    ]);
    expect(hits.map((h) => h.kind)).toEqual([
      "method",
      "declaration",
      "method",
      "declaration",
      "declaration",
      "declaration",
    ]);
  });

  it("places the column on the name, not where the match starts", () => {
    const [h] = rankDefinitions("fooBar", [file("src/a.ts", [2, "    export async function fooBar() {"])]);
    // 4 spaces, then "export async function " (22): the name is at column 27.
    expect(h.col).toBe(27);
    const [m] = rankDefinitions("fooBar", [file("src/a.ts", [5, "  static fooBar(a) {"])]);
    expect(m.col).toBe(10);
  });

  it("falls back to the match's column without a range to anchor it", () => {
    const [h] = rankDefinitions("fooBar", [
      { path: "a.go", matches: [{ line: 1, col: 1, text: "func fooBar() {}", ranges: [] }] },
    ]);
    expect(h.col).toBe(1);
  });

  it("knows test, vendored and declaration files", () => {
    for (const p of [
      "node_modules/a/b.js",
      "packages/x/node_modules/y.js",
      "src/a.test.ts",
      "src/a.spec.tsx",
      "src/__tests__/a.ts",
      "tests/e2e/a.ts",
      "x_test.go",
      "pkg/test_x.py",
      "lib/types.d.ts",
      "dist/index.js",
    ]) {
      expect(isUnlikelyFile(p), p).toBe(true);
    }
    for (const p of ["src/a.ts", "src/testing.ts", "src/contest/a.ts", "latest.ts"]) {
      expect(isUnlikelyFile(p), p).toBe(false);
    }
  });
});

describe("pickDefinition", () => {
  const ranked = (...files: FileSearchFile[]) => rankDefinitions("fooBar", files);

  it("says none for nothing", () => {
    expect(pickDefinition([])).toEqual({ kind: "none" });
  });

  it("opens the only one", () => {
    const out = pickDefinition(ranked(file("src/a.ts", [3, "function fooBar() {"])));
    expect(out).toMatchObject({ kind: "one", hit: { path: "src/a.ts", line: 3 } });
  });

  it("opens one that outranks the rest", () => {
    const out = pickDefinition(
      ranked(
        file("src/a.ts", [3, "function fooBar() {"]),
        file("src/a.test.ts", [1, "function fooBar() {"]),
      ),
    );
    expect(out).toMatchObject({ kind: "one", hit: { path: "src/a.ts" } });
  });

  it("lists several equally likely", () => {
    const out = pickDefinition(
      ranked(
        file("src/a.ts", [3, "function fooBar() {"]),
        file("src/b.ts", [1, "export const fooBar = () => 2;"]),
      ),
    );
    expect(out.kind).toBe("several");
    expect(out.kind === "several" && out.hits.map((h) => h.path)).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

describe("findDefinition", () => {
  it("searches with the definition pattern and picks", async () => {
    const search = vi.fn(async () => ({
      ok: true as const,
      files: [file("src/a.ts", [3, "function fooBar() {"])],
      total: 1,
      truncated: false,
      engine: "rg" as const,
    }));
    const out = await findDefinition("fooBar", search, null);
    expect(search).toHaveBeenCalledWith(definitionSearch("fooBar"));
    expect(out).toMatchObject({ kind: "one", hit: { path: "src/a.ts", line: 3 } });
  });

  it("hands back a failed search", async () => {
    const failed = { ok: false as const, reason: "failed" as const, message: "nope" };
    expect(await findDefinition("fooBar", async () => failed, null)).toEqual(failed);
  });
});
