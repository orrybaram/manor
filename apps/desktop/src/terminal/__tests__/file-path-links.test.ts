import { describe, expect, it } from "vitest";
import { matchFilePaths, workspaceCandidates } from "../file-path-links";

/** What the link covers on the line, with its line and column. */
function links(line: string) {
  return matchFilePaths(line).map((m) => ({
    text: line.slice(m.start, m.end),
    path: m.path,
    line: m.line,
    col: m.col,
  }));
}

describe("matchFilePaths", () => {
  it("finds a relative path", () => {
    expect(links("edited src/foo.ts")).toEqual([
      { text: "src/foo.ts", path: "src/foo.ts", line: undefined, col: undefined },
    ]);
  });

  it("finds a ./ and a ../ path", () => {
    expect(links("see ./src/foo.ts and ../lib/bar.js").map((l) => l.path)).toEqual([
      "./src/foo.ts",
      "../lib/bar.js",
    ]);
  });

  it("reads :line and :line:col into the link", () => {
    expect(links("src/foo.ts:12")).toEqual([
      { text: "src/foo.ts:12", path: "src/foo.ts", line: 12, col: undefined },
    ]);
    expect(links("src/foo.ts:12:3 - error TS2322")).toEqual([
      { text: "src/foo.ts:12:3", path: "src/foo.ts", line: 12, col: 3 },
    ]);
  });

  it("reads tsc's (line,col)", () => {
    expect(links("src/foo.ts(8,5): error")).toEqual([
      { text: "src/foo.ts(8,5)", path: "src/foo.ts", line: 8, col: 5 },
    ]);
  });

  it("finds an absolute path", () => {
    expect(links("at /work/repo/src/foo.ts:4").map((l) => [l.path, l.line])).toEqual([
      ["/work/repo/src/foo.ts", 4],
    ]);
  });

  it("leaves trailing punctuation off", () => {
    expect(links("Updated src/foo.ts.").map((l) => l.text)).toEqual(["src/foo.ts"]);
    expect(links("src/foo.ts, src/bar.ts; src/baz.ts:3:").map((l) => l.text)).toEqual([
      "src/foo.ts",
      "src/bar.ts",
      "src/baz.ts:3",
    ]);
  });

  it("finds paths in quotes, parentheses, brackets and backticks", () => {
    expect(
      links(`"src/a.ts" 'src/b.ts' (src/c.ts:1) [src/d.ts] \`src/e.ts\``).map((l) => l.text),
    ).toEqual(["src/a.ts", "src/b.ts", "src/c.ts:1", "src/d.ts", "src/e.ts"]);
    expect(links("at foo (/repo/src/x.ts:10:2)").map((l) => l.text)).toEqual([
      "/repo/src/x.ts:10:2",
    ]);
  });

  it("finds a file with an extension and no folder, or a dotfile", () => {
    expect(links("wrote README.md and .env.local").map((l) => l.path)).toEqual([
      "README.md",
      ".env.local",
    ]);
  });

  it("skips words that are no path, and URLs", () => {
    expect(links("just some words")).toEqual([]);
    expect(links("open http://localhost:5173/src/main.ts now")).toEqual([]);
    expect(links("//cdn.example.com/a.js")).toEqual([]);
  });

  it("gives 0-based start and end on the line", () => {
    const [m] = matchFilePaths("  src/foo.ts:12 ok");
    expect([m.start, m.end]).toEqual([2, 15]);
  });
});

describe("workspaceCandidates", () => {
  const root = "/work/repo";

  it("resolves a relative path against the cwd, then the root", () => {
    expect(workspaceCandidates("foo.ts", "/work/repo/src", root)).toEqual([
      "src/foo.ts",
      "foo.ts",
    ]);
  });

  it("resolves against the root when the cwd is unknown or the same", () => {
    expect(workspaceCandidates("./src/foo.ts", null, root)).toEqual(["src/foo.ts"]);
    expect(workspaceCandidates("src/foo.ts", "/work/repo", root)).toEqual(["src/foo.ts"]);
  });

  it("follows .. within the workspace", () => {
    expect(workspaceCandidates("../lib/a.ts", "/work/repo/src", root)).toEqual([
      "lib/a.ts",
    ]);
  });

  it("drops a relative path that climbs out of the workspace", () => {
    expect(workspaceCandidates("../../other/a.ts", "/work/repo/src", root)).toEqual([]);
  });

  it("keeps the root's reading when the cwd is outside the workspace", () => {
    expect(workspaceCandidates("src/a.ts", "/tmp", root)).toEqual(["src/a.ts"]);
  });

  it("makes an absolute path inside the workspace relative", () => {
    expect(workspaceCandidates("/work/repo/src/a.ts", "/elsewhere", root)).toEqual([
      "src/a.ts",
    ]);
    expect(workspaceCandidates("/work/repo/src/a.ts", null, "/work/repo/")).toEqual([
      "src/a.ts",
    ]);
  });

  it("rejects an absolute path outside the workspace, or a sibling sharing its prefix", () => {
    expect(workspaceCandidates("/etc/hosts.txt", null, root)).toEqual([]);
    expect(workspaceCandidates("/work/repo-old/a.ts", null, root)).toEqual([]);
  });
});
