import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentFileAuthors, type FileAuthor } from "./agent-file-authors";

let tmp: string;
/** The workspace: a real folder under `tmp`. */
let w: string;
/** A file in the workspace, written now. */
function file(rel: string): string {
  const p = path.join(w, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "x");
  return p;
}
/** An author whose hook landed just after `p` was written. */
const by = (paneId: string, at = Date.now()): FileAuthor => ({ paneId, agentKind: "claude", at });

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "manor-authors-")));
  w = path.join(tmp, "w");
  fs.mkdirSync(w);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("AgentFileAuthors", () => {
  it("answers a workspace's files by their relative path", async () => {
    const authors = new AgentFileAuthors();
    const a = by("p1");
    const b = by("p2");
    authors.record(file("src/a.ts"), a);
    authors.record(file("README.md"), b);
    fs.mkdirSync(path.join(tmp, "other"));
    fs.writeFileSync(path.join(tmp, "other", "x.ts"), "x");
    authors.record(path.join(tmp, "other", "x.ts"), by("p3"));
    expect(await authors.inWorkspace(w)).toEqual({ "src/a.ts": a, "README.md": b });
    expect(await authors.inWorkspace(`${w}/`)).toEqual(await authors.inWorkspace(w));
  });

  it("keeps the last writer of a file", async () => {
    const authors = new AgentFileAuthors();
    file("a.ts");
    authors.record(path.join(w, "a.ts"), by("p1", Date.now() - 1));
    const last = by("p2");
    authors.record(`${w}/./a.ts`, last);
    expect(await authors.inWorkspace(w)).toEqual({ "a.ts": last });
  });

  it("does not read a sibling folder with the same prefix as the workspace", async () => {
    const authors = new AgentFileAuthors();
    fs.mkdirSync(`${w}-other`);
    fs.writeFileSync(`${w}-other/a.ts`, "x");
    authors.record(`${w}-other/a.ts`, by("p1"));
    expect(await authors.inWorkspace(w)).toEqual({});
  });

  it("drops a relative path, which names no file", async () => {
    const authors = new AgentFileAuthors();
    authors.record("src/a.ts", by("p1"));
    expect(await authors.inWorkspace("/")).toEqual({});
  });

  it("forgets the oldest write past its cap, a rewrite counting as new", async () => {
    const authors = new AgentFileAuthors({ maxFiles: 2 });
    authors.record(file("a"), by("p1"));
    authors.record(file("b"), by("p1"));
    authors.record(path.join(w, "a"), by("p2"));
    authors.record(file("c"), by("p1"));
    expect(Object.keys(await authors.inWorkspace(w)).sort()).toEqual(["a", "c"]);
  });

  it("forgets the author of a file written again since its hook", async () => {
    const authors = new AgentFileAuthors();
    const p = file("a.ts");
    const kept = file("b.ts");
    const hook = Date.now();
    authors.record(p, by("p1", hook));
    authors.record(kept, by("p1", hook));
    // You save it ten seconds later.
    const later = new Date(hook + 10_000);
    fs.utimesSync(p, later, later);
    expect(Object.keys(await authors.inWorkspace(w))).toEqual(["b.ts"]);
  });

  it("forgets the author of a file that is gone", async () => {
    const authors = new AgentFileAuthors();
    const p = file("a.ts");
    authors.record(p, by("p1"));
    fs.rmSync(p);
    expect(await authors.inWorkspace(w)).toEqual({});
  });

  it("matches a file and a workspace however a symlink spells them", async () => {
    const authors = new AgentFileAuthors();
    const link = path.join(tmp, "link");
    fs.symlinkSync(w, link);
    const a = by("p1");
    const b = by("p2");
    // Written through the link, asked for by the real path; and the other way round.
    file("a.ts");
    authors.record(path.join(link, "a.ts"), a);
    authors.record(file("src/b.ts"), b);
    expect(await authors.inWorkspace(w)).toEqual({ "a.ts": a, "src/b.ts": b });
    expect(await authors.inWorkspace(link)).toEqual({ "a.ts": a, "src/b.ts": b });
  });

  it("compares paths case-insensitively on macOS", async () => {
    const authors = new AgentFileAuthors({ platform: "darwin" });
    const a = by("p1");
    authors.record(file("a.ts"), a);
    expect(await authors.inWorkspace(w.toUpperCase())).toEqual({ "a.ts": a });
    const linux = new AgentFileAuthors({ platform: "linux" });
    linux.record(path.join(w, "a.ts"), a);
    expect(await linux.inWorkspace(w.toUpperCase())).toEqual({});
  });
});
