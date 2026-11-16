import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { localExec } from "./backend/exec";
import { ExecShellBackend } from "./backend/exec-shell";
import {
  MAX_SEARCH_MATCHES,
  PREVIEW_CHARS,
  findRanges,
  gitGrepArgs,
  globToRegExp,
  grepArgs,
  parseGitGrep,
  parseGrep,
  parseRgJson,
  preview,
  queryRegExp,
  rgArgs,
  searchWorkspace,
  type FileSearchParams,
  type SearchBackend,
} from "./workspace-search";

/** Whether this machine has `rg`, for the run that needs it. */
const hasRgHere = (await new ExecShellBackend(localExec).which("rg")) !== null;

const base: FileSearchParams = {
  query: "foo",
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  include: [],
  exclude: [],
};
const params = (over: Partial<FileSearchParams> = {}): FileSearchParams => ({
  ...base,
  ...over,
});

/** One `rg --json` match message, as rg prints it. */
function rgMatch(
  path: string,
  line: number,
  text: string,
  submatches: [number, number][],
): string {
  return JSON.stringify({
    type: "match",
    data: {
      path: { text: path },
      lines: { text: `${text}\n` },
      line_number: line,
      absolute_offset: 0,
      submatches: submatches.map(([start, end]) => ({
        match: { text: "x" },
        start,
        end,
      })),
    },
  });
}

const RG_FIXTURE = [
  '{"type":"begin","data":{"path":{"text":"./src/b.ts"}}}',
  rgMatch("./src/b.ts", 3, "  const foo = foo();", [
    [8, 11],
    [14, 17],
  ]),
  '{"type":"end","data":{"path":{"text":"./src/b.ts"},"binary_offset":null,"stats":{}}}',
  '{"type":"begin","data":{"path":{"text":"./a.md"}}}',
  // "é" is two bytes: rg's offsets are bytes, the answer's characters.
  rgMatch("./a.md", 1, "café foo", [[6, 9]]),
  '{"type":"end","data":{"path":{"text":"./a.md"},"binary_offset":null,"stats":{}}}',
  '{"type":"summary","data":{"stats":{}}}',
  "",
].join("\n");

describe("argument building", () => {
  it("rg: json, literal and case-insensitive by default, the query after -e and the path after --", () => {
    const args = rgArgs(params({ query: "-rf" }));
    expect(args.slice(0, 2)).toEqual(["--json", "--no-config"]);
    expect(args).toContain("--fixed-strings");
    expect(args).toContain("--ignore-case");
    expect(args).not.toContain("--word-regexp");
    expect(args.slice(-4)).toEqual(["-e", "-rf", "--", "."]);
    expect(args).toContain("--max-filesize=2097152");
  });

  it("rg: case, word and regex flags", () => {
    const args = rgArgs(
      params({ caseSensitive: true, wholeWord: true, regex: true }),
    );
    expect(args).toContain("--case-sensitive");
    expect(args).toContain("--word-regexp");
    expect(args).not.toContain("--fixed-strings");
  });

  it("rg: include globs also take a folder's contents; exclude globs are negated", () => {
    const args = rgArgs(
      params({
        include: ["*.ts", " src/lib/ ", ""],
        exclude: ["dist", "./x/*.js"],
      }),
    );
    const globs = args.flatMap((a, i) => (args[i - 1] === "--glob" ? [a] : []));
    expect(globs).toEqual([
      "!.git",
      "*.ts",
      "**/*.ts/**",
      "src/lib",
      "src/lib/**",
      "!dist",
      "!x/*.js",
    ]);
  });

  it("git grep: parseable output, untracked but not ignored, pathspecs for globs", () => {
    const args = gitGrepArgs(
      params({ include: ["*.ts"], exclude: ["src/gen"] }),
    );
    expect(args.slice(0, 5)).toEqual([
      "-c",
      "core.quotePath=false",
      "-c",
      "grep.fullName=false",
      "grep",
    ]);
    for (const flag of [
      "-n",
      "--column",
      "-I",
      "--null",
      "--untracked",
      "--exclude-standard",
      "-F",
      "-i",
    ]) {
      expect(args).toContain(flag);
    }
    const dashes = args.indexOf("--");
    expect(args.slice(dashes - 2, dashes)).toEqual(["-e", "foo"]);
    expect(args.slice(dashes + 1)).toEqual([
      ":(glob)**/*.ts",
      ":(glob)**/*.ts/**",
      ":(exclude,glob)src/gen",
      ":(exclude,glob)src/gen/**",
    ]);
  });

  it("git grep: no include searches `.`; regex is -E, case-sensitive drops -i, word is -w", () => {
    const args = gitGrepArgs(
      params({ regex: true, caseSensitive: true, wholeWord: true }),
    );
    expect(args).toContain("-E");
    expect(args).not.toContain("-F");
    expect(args).not.toContain("-i");
    expect(args).toContain("-w");
    expect(args.slice(-2)).toEqual(["--", "."]);
  });

  it("grep: recursive, skips dot-folders and node_modules, prunes slash-free excludes", () => {
    const args = grepArgs(
      params({ query: "--help", exclude: ["*.log", "a/b"] }),
    );
    expect(args.slice(0, 5)).toEqual(["-rnI", "--null", "-m", "200", "-F"]);
    expect(args).toContain("--exclude-dir=.?*");
    expect(args).toContain("--exclude-dir=node_modules");
    expect(args).toContain("--exclude=*.log");
    expect(args).not.toContain("--exclude=a/b");
    expect(args.slice(-4)).toEqual(["-e", "--help", "--", "."]);
  });
});

describe("globs", () => {
  it("match a name at any depth without a slash, anchored with one, and a folder's contents", () => {
    expect(globToRegExp("*.ts").test("a/b/c.ts")).toBe(true);
    expect(globToRegExp("*.ts").test("c.tsx")).toBe(false);
    expect(globToRegExp("node_modules").test("pkg/node_modules/x/y.js")).toBe(
      true,
    );
    expect(globToRegExp("src/lib").test("src/lib/a.ts")).toBe(true);
    expect(globToRegExp("src/lib").test("apps/src/lib/a.ts")).toBe(false);
    expect(globToRegExp("src/**/*.test.ts").test("src/a/b/c.test.ts")).toBe(
      true,
    );
    expect(globToRegExp("src/**/*.test.ts").test("src/c.test.ts")).toBe(true);
    expect(globToRegExp("*.{ts,tsx}").test("x/y.tsx")).toBe(true);
    expect(globToRegExp("file?.[jt]s").test("file1.js")).toBe(true);
    expect(globToRegExp("a+b.c").test("a+b.c")).toBe(true);
  });
});

describe("ranges and previews", () => {
  it("find literal, case-insensitive and whole-word ranges", () => {
    expect(findRanges("Foo foo food", queryRegExp(base)!)).toEqual([
      [0, 3],
      [4, 7],
      [8, 11],
    ]);
    expect(
      findRanges(
        "Foo foo food",
        queryRegExp(params({ caseSensitive: true, wholeWord: true }))!,
      ),
    ).toEqual([[4, 7]]);
    expect(
      findRanges("a.b axb", queryRegExp(params({ query: "a.b" }))!),
    ).toEqual([[0, 3]]);
    expect(
      findRanges(
        "a.b axb",
        queryRegExp(params({ query: "a.b", regex: true }))!,
      ),
    ).toEqual([
      [0, 3],
      [4, 7],
    ]);
  });

  it("skip empty matches and give no RegExp for a pattern JS cannot compile", () => {
    expect(
      findRanges("abc", queryRegExp(params({ query: "x*", regex: true }))!),
    ).toEqual([]);
    expect(queryRegExp(params({ query: "(", regex: true }))).toBeNull();
  });

  it("drop the indent and keep a short line whole", () => {
    expect(preview("    return foo;", [[11, 14]])).toEqual({
      line: 0,
      col: 12,
      text: "return foo;",
      ranges: [[7, 10]],
    });
  });

  it("cut a long line around its first match, with an ellipsis where it was cut", () => {
    const line = `${"a".repeat(1000)}MATCH${"b".repeat(1000)}`;
    const p = preview(line, [[1000, 1005]]);
    expect(p.col).toBe(1001);
    expect(p.text.length).toBeLessThanOrEqual(PREVIEW_CHARS + 2);
    expect(p.text.startsWith("…")).toBe(true);
    expect(p.text.endsWith("…")).toBe(true);
    const [[s, e]] = p.ranges;
    expect(p.text.slice(s, e)).toBe("MATCH");
  });
});

describe("parsing", () => {
  it("rg --json: paths relative, character ranges from byte offsets, lines without endings", () => {
    const parsed = parseRgJson(RG_FIXTURE, MAX_SEARCH_MATCHES);
    expect(parsed.total).toBe(3);
    expect(parsed.capped).toBe(false);
    expect(parsed.files.get("src/b.ts")).toEqual([
      {
        line: 3,
        col: 9,
        text: "const foo = foo();",
        ranges: [
          [6, 9],
          [12, 15],
        ],
      },
    ]);
    expect(parsed.files.get("a.md")).toEqual([
      { line: 1, col: 6, text: "café foo", ranges: [[5, 8]] },
    ]);
  });

  it("rg --json: a cut-off last message is skipped, and the cap stops it", () => {
    const cut = `${RG_FIXTURE}${rgMatch("./z.ts", 1, "foo", [[0, 3]]).slice(0, 30)}`;
    expect(parseRgJson(cut, MAX_SEARCH_MATCHES).total).toBe(3);
    const capped = parseRgJson(RG_FIXTURE, 2);
    expect(capped.total).toBe(2);
    expect(capped.capped).toBe(true);
    expect(capped.files.has("a.md")).toBe(false);
    const mid = parseRgJson(RG_FIXTURE, 1);
    expect(mid.total).toBe(1);
    expect(mid.capped).toBe(true);
    expect(mid.files.get("src/b.ts")?.[0].ranges).toEqual([[6, 9]]);
  });

  it("git grep: path, line and column fields, ranges found in JS", () => {
    const out =
      "src/a.ts\x0012\x005\x00    foo(Foo)\nb c.ts\x001\x001\x00foo\n";
    const parsed = parseGitGrep(out, queryRegExp(base), MAX_SEARCH_MATCHES);
    expect(parsed.files.get("src/a.ts")).toEqual([
      {
        line: 12,
        col: 5,
        text: "foo(Foo)",
        ranges: [
          [0, 3],
          [4, 7],
        ],
      },
    ]);
    expect(parsed.files.get("b c.ts")).toEqual([
      { line: 1, col: 1, text: "foo", ranges: [[0, 3]] },
    ]);
    expect(parsed.total).toBe(3);
  });

  it("git grep: a pattern JS cannot read still answers its line, at git's column", () => {
    const parsed = parseGitGrep(
      "a.ts\x002\x007\x00  x = [[:alpha:]]\n",
      null,
      MAX_SEARCH_MATCHES,
    );
    expect(parsed.files.get("a.ts")).toEqual([
      { line: 2, col: 7, text: "x = [[:alpha:]]", ranges: [] },
    ]);
    expect(parsed.total).toBe(1);
  });

  it("git grep and grep: a capped output drops its last record, as a remote daemon's `…[truncated]` follows it", () => {
    const out = "a.ts\x001\x001\x00foo\nb.ts\x001\x001\x00fo\n…[truncated]";
    expect(
      parseGitGrep(out, queryRegExp(base), 10, true).files.has("b.ts"),
    ).toBe(false);
    expect(parseGitGrep(out, queryRegExp(base), 10, true).total).toBe(1);
    const g = "./a.ts\x001:foo\n./b.ts\x001:fo\n…[truncated]";
    expect([
      ...parseGrep(g, queryRegExp(base), 10, () => true, true).files.keys(),
    ]).toEqual(["a.ts"]);
  });

  it("rg --json: a line that is not UTF-8 maps offsets over the bytes rg read", () => {
    // 0xff is no UTF-8; it decodes to one U+FFFD, which re-encodes as three bytes.
    const raw = Buffer.concat([Buffer.from([0xff]), Buffer.from(" foo\n")]);
    const msg = JSON.stringify({
      type: "match",
      data: {
        path: { text: "./bin.txt" },
        lines: { bytes: raw.toString("base64") },
        line_number: 1,
        submatches: [{ start: 2, end: 5 }],
      },
    });
    const m = parseRgJson(`${msg}\n`, 10).files.get("bin.txt")![0];
    expect(m.text.slice(...m.ranges[0])).toBe("foo");
  });

  it("git grep: a cut-off last line is dropped", () => {
    expect(
      parseGitGrep(
        "a.ts\x001\x001\x00foo\nb.ts\x001\x00",
        queryRegExp(base),
        10,
      ).total,
    ).toBe(1);
  });

  it("grep: path then line:text, ./ dropped, colons in the text kept, globs filtered", () => {
    const out = "./a.ts\x003:foo: bar\n./dist/b.ts\x009:foo\n./c.md\x001:foo\n";
    const keepTs = (p: string) => p.endsWith(".ts") && !p.startsWith("dist/");
    const parsed = parseGrep(
      out,
      queryRegExp(base),
      MAX_SEARCH_MATCHES,
      keepTs,
    );
    expect([...parsed.files.keys()]).toEqual(["a.ts"]);
    expect(parsed.files.get("a.ts")).toEqual([
      { line: 3, col: 1, text: "foo: bar", ranges: [[0, 3]] },
    ]);
  });
});

/** A backend whose commands are answered by `answer`, and whose `which rg` by `rg`. */
function fakeBackend(
  rg: string | null,
  answer: (cmd: string, args: string[]) => string | Error,
): SearchBackend & {
  exec: ReturnType<typeof vi.fn>;
  which: ReturnType<typeof vi.fn>;
} {
  const exec = vi.fn(async (cmd: string, args: string[]) => {
    const out = answer(cmd, args);
    if (out instanceof Error) throw out;
    return out;
  });
  const which = vi.fn(async () => rg);
  return { shell: { exec, which }, exec, which };
}

function execError(
  message: string,
  fields: { code: number | string | null; stdout?: string; stderr?: string },
) {
  return Object.assign(new Error(message), {
    stdout: "",
    stderr: "",
    ...fields,
  });
}

describe("searchWorkspace", () => {
  it("runs nothing for an empty query", async () => {
    const b = fakeBackend("/usr/bin/rg", () => "");
    expect(await searchWorkspace(b, "/w", params({ query: "" }))).toEqual({
      ok: true,
      files: [],
      total: 0,
      truncated: false,
      engine: null,
    });
    expect(b.exec).not.toHaveBeenCalled();
    expect(b.which).not.toHaveBeenCalled();
  });

  it("uses rg when the host has it, asking once per backend, in the workspace, sorted by path", async () => {
    const b = fakeBackend("/usr/bin/rg", () => RG_FIXTURE);
    const result = await searchWorkspace(b, "/w", base);
    await searchWorkspace(b, "/w", base);
    expect(b.which).toHaveBeenCalledTimes(1);
    expect(b.exec.mock.calls[0][0]).toBe("rg");
    expect(b.exec.mock.calls[0][2]).toMatchObject({
      cwd: "/w",
      timeout: 15_000,
    });
    expect(result).toMatchObject({
      ok: true,
      engine: "rg",
      total: 3,
      truncated: false,
    });
    if (result.ok)
      expect(result.files.map((f) => f.path)).toEqual(["a.md", "src/b.ts"]);
  });

  it("falls back to git grep when the host has no rg", async () => {
    const b = fakeBackend(null, (cmd) =>
      cmd === "git" ? "a.ts\x001\x001\x00foo\n" : new Error("unexpected"),
    );
    const result = await searchWorkspace(b, "/w", base);
    expect(b.exec.mock.calls.map((c) => c[0])).toEqual(["git"]);
    expect(result).toMatchObject({ ok: true, engine: "git-grep", total: 1 });
  });

  it("falls back to grep outside a git repo, filtering include globs itself", async () => {
    const b = fakeBackend(null, (cmd) =>
      cmd === "git"
        ? execError("Command failed", {
            code: 128,
            stderr: "fatal: not a git repository (or any parent)",
          })
        : "./a.ts\x001:foo\n./b.md\x002:foo\n",
    );
    const result = await searchWorkspace(
      b,
      "/w",
      params({ include: ["*.ts"] }),
    );
    expect(b.exec.mock.calls.map((c) => c[0])).toEqual(["git", "grep"]);
    expect(result).toMatchObject({ ok: true, engine: "grep", total: 1 });
    if (result.ok) expect(result.files.map((f) => f.path)).toEqual(["a.ts"]);
  });

  it("answers no matches for exit 1", async () => {
    const b = fakeBackend("/usr/bin/rg", () =>
      execError("Command failed", { code: 1 }),
    );
    expect(await searchWorkspace(b, "/w", base)).toMatchObject({
      ok: true,
      files: [],
      total: 0,
      truncated: false,
    });
  });

  it("answers an invalid regex as a readable refusal", async () => {
    const stderr =
      "rg: regex parse error:\n    (\n    ^\nerror: unclosed group\n";
    const b = fakeBackend("/usr/bin/rg", () =>
      execError("Command failed", { code: 2, stderr }),
    );
    expect(
      await searchWorkspace(b, "/w", params({ query: "(", regex: true })),
    ).toEqual({
      ok: false,
      reason: "invalid-query",
      message: stderr.trim(),
    });
  });

  it("keeps what it found before a timeout or maxBuffer, here or on a remote host, as truncated", async () => {
    const stops = [
      { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" },
      { code: null, killed: true },
      { code: null, stderr: "\n[timed out after 15000ms]" },
      { code: 143, stderr: "\n[timed out after 15000ms]" },
    ];
    for (const stop of stops) {
      const b = fakeBackend("/usr/bin/rg", () =>
        Object.assign(
          execError("stopped", { code: stop.code, stdout: RG_FIXTURE }),
          stop,
        ),
      );
      expect(await searchWorkspace(b, "/w", base)).toMatchObject({
        ok: true,
        total: 3,
        truncated: true,
      });
    }
  });

  it("throws on a lost connection rather than answering no results", async () => {
    const lost = Object.assign(
      execError("Command failed", { code: null, stderr: "connection closed" }),
      {
        cause: new Error("connection closed"),
      },
    );
    const b = fakeBackend("/usr/bin/rg", () => lost);
    await expect(searchWorkspace(b, "/w", base)).rejects.toBe(lost);
  });

  it("falls back to grep when the host cannot start git (a remote spawn failure), and throws when grep cannot start either", async () => {
    const spawnFailed = () =>
      execError("Command failed", { code: null, stderr: "spawn git ENOENT" });
    const b = fakeBackend(null, (cmd) =>
      cmd === "git" ? spawnFailed() : "./a.ts\x001:foo\n",
    );
    expect(await searchWorkspace(b, "/w", base)).toMatchObject({
      ok: true,
      engine: "grep",
      total: 1,
    });
    const gone = fakeBackend(null, () => spawnFailed());
    await expect(searchWorkspace(gone, "/gone", base)).rejects.toThrow();
  });

  it("falls back to grep on any git refusal but a bad pattern: a localised not-a-repo, dubious ownership, an old git", async () => {
    for (const [code, stderr] of [
      [
        128,
        "fatal: kein Git-Repository (oder irgendeines der Elternverzeichnisse): .git",
      ],
      [128, "fatal: detected dubious ownership in repository at '/w'"],
      [129, "error: unknown option `column'"],
    ] as const) {
      const b = fakeBackend(null, (cmd) =>
        cmd === "git"
          ? execError("Command failed", { code, stderr })
          : "./a.ts\x001:foo\n",
      );
      expect(await searchWorkspace(b, "/w", base)).toMatchObject({
        ok: true,
        engine: "grep",
      });
    }
    const badRe = fakeBackend(null, (cmd) =>
      cmd === "git"
        ? execError("Command failed", {
            code: 128,
            stderr: "fatal: command line, '(': Unmatched ( or \\(",
          })
        : "",
    );
    expect(
      await searchWorkspace(badRe, "/w", params({ query: "(", regex: true })),
    ).toMatchObject({
      ok: false,
      reason: "invalid-query",
    });
  });

  it("answers what it found past files it could not read, and fails on any other refusal", async () => {
    const unreadable = fakeBackend(null, (cmd) =>
      cmd === "git"
        ? execError("x", { code: 128, stderr: "fatal: not a git repository" })
        : execError("x", {
            code: 2,
            stderr: "grep: ./secret: Permission denied\n",
          }),
    );
    expect(
      await searchWorkspace(unreadable, "/w", params({ regex: true })),
    ).toMatchObject({ ok: true, total: 0 });
    const badGlob = fakeBackend("/usr/bin/rg", () =>
      execError("x", {
        code: 2,
        stderr: "rg: error parsing glob '{': unclosed alternate group",
      }),
    );
    expect(
      await searchWorkspace(badGlob, "/w", params({ include: ["{"] })),
    ).toMatchObject({
      ok: false,
      reason: "failed",
    });
  });

  it("refuses a query with a line break, and a glob that leaves the workspace, before running anything", async () => {
    const b = fakeBackend("/usr/bin/rg", () => "");
    expect(
      await searchWorkspace(b, "/w", params({ query: "a\nb" })),
    ).toMatchObject({ ok: false, reason: "invalid-query" });
    for (const glob of ["../**", "src/../../x", " ../ "]) {
      expect(
        await searchWorkspace(b, "/w", params({ include: [glob] })),
      ).toMatchObject({ ok: false, reason: "invalid-query" });
      expect(
        await searchWorkspace(b, "/w", params({ exclude: [glob] })),
      ).toMatchObject({ ok: false, reason: "invalid-query" });
    }
    expect(b.exec).not.toHaveBeenCalled();
  });

  it("re-asks for rg after a while when it was not found, but never once it was", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      const missing = fakeBackend(null, () => "");
      await searchWorkspace(missing, "/w", base);
      await searchWorkspace(missing, "/w", base);
      expect(missing.which).toHaveBeenCalledTimes(1);
      now.mockReturnValue(1_000_000 + 61_000);
      await searchWorkspace(missing, "/w", base);
      expect(missing.which).toHaveBeenCalledTimes(2);

      const found = fakeBackend("/usr/bin/rg", () => "");
      await searchWorkspace(found, "/w", base);
      now.mockReturnValue(9_000_000);
      await searchWorkspace(found, "/w", base);
      expect(found.which).toHaveBeenCalledTimes(1);
    } finally {
      now.mockRestore();
    }
  });

  it("marks truncated when a file reaches the per-file cap", async () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      rgMatch("./a.ts", i + 1, "foo", [[0, 3]]),
    ).join("\n");
    const b = fakeBackend("/usr/bin/rg", () => many);
    expect(await searchWorkspace(b, "/w", base)).toMatchObject({
      total: 200,
      truncated: true,
    });
  });

  it("holds to maxResults, never past the cap", async () => {
    const many = Array.from({ length: 2500 }, (_, i) =>
      rgMatch("./a.ts", i + 1, "foo", [[0, 3]]),
    ).join("\n");
    const b = fakeBackend("/usr/bin/rg", () => many);
    expect(await searchWorkspace(b, "/w", base)).toMatchObject({
      total: MAX_SEARCH_MATCHES,
      truncated: true,
    });
    expect(
      await searchWorkspace(b, "/w", params({ maxResults: 10 })),
    ).toMatchObject({ total: 10, truncated: true });
    expect(
      await searchWorkspace(b, "/w", params({ maxResults: 1e9 })),
    ).toMatchObject({ total: MAX_SEARCH_MATCHES });
  });

  it("throws when the workspace is gone", async () => {
    const b = fakeBackend("/usr/bin/rg", () =>
      execError("spawn rg ENOENT", { code: "ENOENT" }),
    );
    await expect(searchWorkspace(b, "/gone", base)).rejects.toThrow(/ENOENT/);
  });
});

describe("searchWorkspace on this machine", () => {
  /** A real backend, with `rg` hidden when `rg` is false. */
  function local(rg: boolean): SearchBackend {
    const shell = new ExecShellBackend(localExec);
    return {
      shell: {
        exec: (cmd, args, opts) => shell.exec(cmd, args, opts),
        which: (bin) =>
          bin === "rg" && !rg ? Promise.resolve(null) : shell.which(bin),
      },
    };
  }

  async function fixture(git: boolean): Promise<string> {
    const dir = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "manor-search-")),
    );
    await mkdir(path.join(dir, "src"), { recursive: true });
    await mkdir(path.join(dir, "node_modules"), { recursive: true });
    await writeFile(
      path.join(dir, "src", "a.ts"),
      "export function fooBar() {}\nconst x = fooBar();\n",
    );
    await writeFile(path.join(dir, "b.md"), "café fooBar\n");
    await writeFile(path.join(dir, "-dash.txt"), "-n fooBar\n");
    await writeFile(path.join(dir, "ignored.log"), "fooBar\n");
    await writeFile(path.join(dir, "node_modules", "dep.js"), "fooBar\n");
    await writeFile(
      path.join(dir, ".gitignore"),
      "ignored.log\nnode_modules\n",
    );
    if (git) {
      await localExec.file("git", ["init", "-q"], { cwd: dir });
      await localExec.file("git", ["add", "src/a.ts"], { cwd: dir });
    }
    return dir;
  }

  const engines = [
    { name: "rg", git: true, rg: true },
    { name: "git-grep", git: true, rg: false },
    { name: "grep", git: false, rg: false },
  ] as const;

  for (const e of engines) {
    it.skipIf(e.rg && !hasRgHere)(
      `${e.name}: finds, highlights and filters the same`,
      async () => {
        const dir = await fixture(e.git);
        try {
          const backend = local(e.rg);
          const all = await searchWorkspace(
            backend,
            dir,
            params({ query: "foobar" }),
          );
          expect(all).toMatchObject({
            ok: true,
            engine: e.name,
            truncated: false,
          });
          if (!all.ok) return;
          const paths = all.files.map((f) => f.path);
          expect(paths).toEqual(
            expect.arrayContaining(["-dash.txt", "b.md", "src/a.ts"]),
          );
          expect(paths).not.toContain("node_modules/dep.js");
          if (e.name !== "grep") expect(paths).not.toContain("ignored.log");
          const md = all.files.find((f) => f.path === "b.md")!.matches[0];
          expect(md.text.slice(...md.ranges[0])).toBe("fooBar");

          const dash = await searchWorkspace(
            backend,
            dir,
            params({ query: "-n foo" }),
          );
          expect(dash.ok && dash.files.map((f) => f.path)).toEqual([
            "-dash.txt",
          ]);

          const word = await searchWorkspace(
            backend,
            dir,
            params({ query: "foo", wholeWord: true }),
          );
          expect(word).toMatchObject({ ok: true, total: 0 });

          const cased = await searchWorkspace(
            backend,
            dir,
            params({ query: "foobar", caseSensitive: true }),
          );
          expect(cased).toMatchObject({ ok: true, total: 0 });

          const ts = await searchWorkspace(
            backend,
            dir,
            params({ query: "fooBar", include: ["*.ts"] }),
          );
          expect(ts.ok && ts.files).toEqual([
            {
              path: "src/a.ts",
              matches: [
                {
                  line: 1,
                  col: 17,
                  text: "export function fooBar() {}",
                  ranges: [[16, 22]],
                },
                {
                  line: 2,
                  col: 11,
                  text: "const x = fooBar();",
                  ranges: [[10, 16]],
                },
              ],
            },
          ]);

          const notSrc = await searchWorkspace(
            backend,
            dir,
            params({ query: "fooBar", exclude: ["src"] }),
          );
          expect(notSrc.ok && notSrc.files.map((f) => f.path)).not.toContain(
            "src/a.ts",
          );

          const re = await searchWorkspace(
            backend,
            dir,
            params({ query: "function fo+B", regex: true }),
          );
          expect(re).toMatchObject({ ok: true, total: 1 });

          const bad = await searchWorkspace(
            backend,
            dir,
            params({ query: "(", regex: true }),
          );
          expect(bad).toMatchObject({ ok: false, reason: "invalid-query" });
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      },
    );
  }
});
