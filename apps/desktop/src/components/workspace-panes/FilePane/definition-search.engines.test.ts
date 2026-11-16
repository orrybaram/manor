import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { localExec } from "../../../../electron/backend/exec";
import { ExecShellBackend } from "../../../../electron/backend/exec-shell";
import { searchWorkspace, type SearchBackend } from "../../../../electron/workspace-search";
import { definitionSearch, rankDefinitions } from "./definition-search";

/**
 * The definition pattern run for real through each of `files.search`'s
 * engines: `rg` (Rust regex), `git grep -E` and `grep -E` (POSIX ERE). Each
 * must find the same lines, and the ranker place the name the same.
 */

const hasRgHere = (await new ExecShellBackend(localExec).which("rg")) !== null;

function local(rg: boolean): SearchBackend {
  const shell = new ExecShellBackend(localExec);
  return {
    shell: {
      exec: (cmd, args, opts) => shell.exec(cmd, args, opts),
      which: (bin) => (bin === "rg" && !rg ? Promise.resolve(null) : shell.which(bin)),
    },
  };
}

const SAMPLES: Record<string, string> = {
  "src/a.ts": [
    "import { fooBar } from './b';",
    "// function fooBar is in b",
    "export function fooBar(a: number) {}",
    "const x = fooBar(2);",
    "  fooBar(\"x\", () => {",
    "export class Widget {",
    "  public static async fooBar(a: string): Promise<void> {",
    "  }",
    "}",
    "export const fooBarBaz = 1;",
    "",
  ].join("\n"),
  "src/b.py": ["def fooBar(x):", "    return fooBar(x - 1)", "class fooBar:", "    pass", ""].join(
    "\n",
  ),
  "src/c.go": [
    "package c",
    "func fooBar() {}",
    "func (r *T) fooBar(x int) error {",
    "\treturn fooBar()",
    "}",
    "type fooBar struct{}",
    "",
  ].join("\n"),
  "src/d.rs": ["pub fn fooBar() {}", "let mut fooBar = 1;", "\tfn\tfooBar() {}", "fooBar();", ""].join(
    "\n",
  ),
};

/** Every definition of fooBar in the samples, as path:line:col of the name. */
const EXPECTED = [
  "src/a.ts:3:17",
  "src/a.ts:7:23",
  "src/b.py:1:5",
  "src/b.py:3:7",
  "src/c.go:2:6",
  "src/c.go:3:13",
  "src/c.go:6:6",
  "src/d.rs:1:8",
  "src/d.rs:2:9",
  "src/d.rs:3:5",
];

async function fixture(git: boolean): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "manor-definition-")));
  await mkdir(path.join(dir, "src"), { recursive: true });
  for (const [rel, text] of Object.entries(SAMPLES)) await writeFile(path.join(dir, rel), text);
  if (git) {
    await localExec.file("git", ["init", "-q"], { cwd: dir });
    await localExec.file("git", ["add", "."], { cwd: dir });
  }
  return dir;
}

describe("the definition pattern on this machine's engines", () => {
  const engines = [
    { name: "rg", git: true, rg: true },
    { name: "git-grep", git: true, rg: false },
    { name: "grep", git: false, rg: false },
  ] as const;

  for (const e of engines) {
    it.skipIf(e.rg && !hasRgHere)(`${e.name}: finds the definitions and places their names`, async () => {
      const dir = await fixture(e.git);
      try {
        const result = await searchWorkspace(local(e.rg), dir, definitionSearch("fooBar"));
        expect(result).toMatchObject({ ok: true, engine: e.name });
        if (!result.ok) return;
        const hits = rankDefinitions("fooBar", result.files);
        expect(hits.map((h) => `${h.path}:${h.line}:${h.col}`).sort()).toEqual(EXPECTED);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
});
