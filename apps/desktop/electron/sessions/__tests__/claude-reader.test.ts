import { cp, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { claudeProjectsDir, createClaudeReader, summarizeClaudeTranscript } from "../claude-reader";
import { readJsonlWindows } from "../jsonl-window";
import type { SessionEnv, SessionSummary } from "../types";

const FIXTURES = join(__dirname, "../__fixtures__/claude");

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const C = "cccccccc-0000-4000-8000-000000000003";
const D = "dddddddd-0000-4000-8000-000000000004";

let dir: string;
let env: SessionEnv;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "claude-reader-"));
  await cp(FIXTURES, join(dir, "config"), { recursive: true });
  env = { home: join(dir, "home"), env: { CLAUDE_CONFIG_DIR: join(dir, "config") } };
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function byId(list: SessionSummary[]): Record<string, SessionSummary> {
  return Object.fromEntries(list.map((s) => [s.sessionId, s]));
}

describe("claudeProjectsDir", () => {
  it("uses CLAUDE_CONFIG_DIR when set, else ~/.claude", () => {
    expect(claudeProjectsDir({ home: "/h", env: { CLAUDE_CONFIG_DIR: "/cfg" } })).toBe("/cfg/projects");
    expect(claudeProjectsDir({ home: "/h", env: {} })).toBe("/h/.claude/projects");
  });
});

describe("the Claude reader", () => {
  it("lists only top-level transcripts that hold a conversation", async () => {
    const list = await createClaudeReader().list(env);
    // Not the subagent, orphaned, superseded, old-style agent-* or metadata-only files.
    expect(list.map((s) => s.sessionId).sort()).toEqual([A, B, C]);
  });

  it("titles a Session by the user's name, then Claude's title, then the first prompt", async () => {
    const sessions = byId(await createClaudeReader().list(env));
    // `agent-name` beats the later `ai-title`.
    expect(sessions[A].title).toBe("Toast cleanup");
    expect(sessions[A].firstPrompt).toBe("Fix the flaky toast test");
    // `ai-title` beats the first prompt.
    expect(sessions[B].title).toBe("Session scanner");
    expect(sessions[B].firstPrompt).toBe("Write the scanner\n\nwith tests");
    // No title: the first prompt, on one line.
    expect(sessions[C].title).toBe("Why does the dropdown clip?");
  });

  it("skips the compaction preamble, commands, tool results, notifications and bare images for the first prompt", async () => {
    const sessions = byId(await createClaudeReader().list(env));
    expect(sessions[C].firstPrompt).toBe("Why does the  dropdown\nclip?");
  });

  it("takes the cwd from the records, not the lossy directory name", async () => {
    const sessions = byId(await createClaudeReader().list(env));
    expect(sessions[C].cwd).toBe("/home/u/.manor/worktrees/my-repo/fix-it");
    expect(sessions[C].gitBranch).toBe("fix-it");
    expect(sessions[A].cwd).toBe("/home/u/work/my-repo");
  });

  it("reads times, model and path", async () => {
    const path = join(dir, "config/projects/-home-u-work-my-repo", `${A}.jsonl`);
    const when = new Date("2026-10-25T09:30:00.000Z");
    await utimes(path, when, when);
    const a = byId(await createClaudeReader().list(env))[A];
    expect(a).toMatchObject({
      id: `claude:${A}`,
      hostId: "local",
      kind: "claude",
      createdAt: "2026-10-20T10:00:00.000Z",
      updatedAt: when.toISOString(),
      // Claude's `<synthetic>` placeholder is not a model.
      model: "claude-sonnet-5",
      messageCount: null,
      parentSessionId: null,
      path,
    });
  });

  it("reuses a file's summary while its size and mtime are unchanged", async () => {
    const reader = createClaudeReader();
    const path = join(dir, "config/projects/-home-u-work-my-repo", `${B}.jsonl`);
    // A whole second, so setting it back is exact.
    const mtime = new Date("2026-10-25T09:30:00.000Z");
    await utimes(path, mtime, mtime);
    expect(byId(await reader.list(env))[B].title).toBe("Session scanner");

    // Same length, same mtime: not read again.
    const text = await readFile(path, "utf8");
    const renamed = text.replace("Session scanner", "Session scanneR");
    expect(renamed.length).toBe(text.length);
    await writeFile(path, renamed);
    await utimes(path, mtime, mtime);
    expect(byId(await reader.list(env))[B].title).toBe("Session scanner");

    // A new mtime: read again.
    const later = new Date(mtime.getTime() + 60_000);
    await utimes(path, later, later);
    expect(byId(await reader.list(env))[B].title).toBe("Session scanneR");
  });

  it("forgets a transcript that is gone", async () => {
    const reader = createClaudeReader();
    await reader.list(env);
    await rm(join(dir, "config/projects/-home-u-work-my-repo", `${B}.jsonl`));
    expect((await reader.list(env)).map((s) => s.sessionId).sort()).toEqual([A, C]);
  });

  it("lists nothing when there is no store", async () => {
    expect(await createClaudeReader().list({ home: join(dir, "nowhere"), env: {} })).toEqual([]);
  });
});

describe("summarizeClaudeTranscript", () => {
  const user = (content: string, extra: Record<string, unknown> = {}) => ({
    type: "user",
    cwd: "/w",
    timestamp: "2026-10-28T10:00:00.000Z",
    message: { role: "user", content },
    ...extra,
  });

  it("takes a slash command with words after it as the prompt, and skips one without", () => {
    const records = [
      user("<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>"),
      user("<command-message>feature</command-message>\n<command-name>/feature</command-name>\n<command-args>fix the modal</command-args>", { origin: { kind: "human" } }),
    ];
    const summary = summarizeClaudeTranscript(`/p/${A}.jsonl`, 0, records, records);
    expect(summary?.firstPrompt).toBe("/feature fix the modal");
  });

  it("names a fork's parent only from its forkedFrom field", () => {
    const forked = [user("hello", { sessionId: A, forkedFrom: { sessionId: B } })];
    expect(summarizeClaudeTranscript(`/p/${A}.jsonl`, 0, forked, forked)?.parentSessionId).toBe(B);
    // An older `--resume` copied the history under the old id: no fork.
    const resumed = [user("hello", { sessionId: B })];
    expect(summarizeClaudeTranscript(`/p/${A}.jsonl`, 0, resumed, resumed)?.parentSessionId).toBeNull();
  });

  it("gives each Session the record id kind:sessionId", () => {
    const records = [user("hello")];
    expect(summarizeClaudeTranscript(`/p/${A}.jsonl`, 0, records, records)?.id).toBe(`claude:${A}`);
  });
});

describe("the Claude reader, with lines longer than a window", () => {
  const project = () => join(dir, "config/projects/-home-u-big");
  const line = (record: Record<string, unknown>) => `${JSON.stringify(record)}\n`;
  const filler = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      line({ type: "assistant", cwd: "/w/old", message: { role: "assistant", model: "m", content: `reply ${i} ${"x".repeat(200)}` } }),
    ).join("");

  it("keeps the latest title and cwd before a last line over 64 KB", async () => {
    await mkdir(project(), { recursive: true });
    const path = join(project(), `${D}.jsonl`);
    await writeFile(
      path,
      line({ type: "user", cwd: "/w/old", timestamp: "2026-10-28T10:00:00.000Z", message: { role: "user", content: "start" } }) +
        filler(1000) +
        line({ type: "ai-title", aiTitle: "Big tail" }) +
        line({ type: "assistant", cwd: "/w/new", message: { role: "assistant", model: "m2", content: "y".repeat(100 * 1024) } }),
    );
    const a = byId(await createClaudeReader().list(env))[D];
    expect(a).toMatchObject({ title: "Big tail", cwd: "/w/new", model: "m2", firstPrompt: "start" });
  });

  it("keeps a first prompt over 64 KB", async () => {
    await mkdir(project(), { recursive: true });
    const path = join(project(), `${D}.jsonl`);
    const prompt = `fix it ${"z".repeat(100 * 1024)}`;
    await writeFile(
      path,
      line({ type: "file-history-snapshot", messageId: "m" }) +
        line({ type: "user", cwd: "/w", timestamp: "2026-10-28T10:00:00.000Z", message: { role: "user", content: prompt } }) +
        filler(1000),
    );
    const a = byId(await createClaudeReader().list(env))[D];
    expect(a.firstPrompt.startsWith("fix it zzz")).toBe(true);
    expect(a.title.startsWith("fix it zzz")).toBe(true);
  });

  it("still lists a transcript whose only lines are past the cap, as a bare row", async () => {
    await mkdir(project(), { recursive: true });
    const path = join(project(), `${D}.jsonl`);
    // Each line longer than the 4 MB cap.
    const huge = line({ type: "user", cwd: "/w", message: { role: "user", content: "q".repeat(4.5 * 1024 * 1024) } });
    await writeFile(path, huge + huge);
    const { size, mtimeMs } = await stat(path);
    expect(await readJsonlWindows(path, size)).toEqual({ head: [], tail: [], capped: true });
    const a = byId(await createClaudeReader().list(env))[D];
    expect(a).toMatchObject({
      id: `claude:${D}`,
      title: "",
      cwd: "",
      updatedAt: new Date(mtimeMs).toISOString(),
      path,
    });
  });
});

describe("readJsonlWindows", () => {
  it("reads the head and tail of a large file, dropping lines the windows cut", async () => {
    const path = join(dir, "big.jsonl");
    const lines = Array.from({ length: 200 }, (_, i) => JSON.stringify({ i, pad: "x".repeat(40) }));
    await writeFile(path, `${lines.join("\n")}\n`);
    const { size } = await stat(path);
    const { head, tail } = await readJsonlWindows(path, size, 1024);
    const ids = (records: unknown[]) => records.map((r) => (r as { i: number }).i);
    expect(ids(head)[0]).toBe(0);
    expect(ids(tail)[ids(tail).length - 1]).toBe(199);
    // Only whole lines, each in order, and nothing from the middle.
    expect(ids(head)).toEqual([...Array(ids(head).length).keys()]);
    expect(ids(tail)).toEqual(ids(tail).map((_, k) => 200 - ids(tail).length + k));
    expect(ids(head).length + ids(tail).length).toBeLessThan(200);
  });
});
