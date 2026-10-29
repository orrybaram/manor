import { cp, mkdir, mkdtemp, readFile, rename, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createPiReader, piSessionIdFromPath, piSessionsDir, summarizePiSession } from "../pi-reader";
import type { SessionEnv, SessionSummary } from "../types";

const FIXTURES = join(__dirname, "../__fixtures__/pi");

const A = "aaaaaaaa-0000-4000-8000-0000000000a1";
const B = "bbbbbbbb-0000-4000-8000-0000000000b2";
const C = "cccccccc-0000-4000-8000-0000000000c3";
const D = "dddddddd-0000-4000-8000-0000000000d4";

const REPO = "--home-u-work-my-repo--";
const A_FILE = `2026-10-20T10-00-00-000Z_${A}.jsonl`;
const B_FILE = `2026-10-21T08-30-00-000Z_${B}.jsonl`;

let dir: string;
let env: SessionEnv;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-reader-"));
  await cp(FIXTURES, join(dir, "pi"), { recursive: true });
  env = { home: join(dir, "home"), env: { PI_CODING_AGENT_DIR: join(dir, "pi/agent") } };
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function byId(list: SessionSummary[]): Record<string, SessionSummary> {
  return Object.fromEntries(list.map((s) => [s.sessionId, s]));
}

describe("piSessionsDir", () => {
  it("uses PI_CODING_AGENT_SESSION_DIR, else PI_CODING_AGENT_DIR/sessions, else ~/.pi/agent/sessions", () => {
    const at = (vars: Record<string, string>) => piSessionsDir({ home: "/h", env: vars });
    expect(at({ PI_CODING_AGENT_SESSION_DIR: "/s", PI_CODING_AGENT_DIR: "/a" })).toBe("/s");
    expect(at({ PI_CODING_AGENT_DIR: "/a" })).toBe("/a/sessions");
    expect(at({})).toBe("/h/.pi/agent/sessions");
    expect(at({ PI_CODING_AGENT_SESSION_DIR: "~/pi-sessions" })).toBe("/h/pi-sessions");
  });
});

describe("piSessionIdFromPath", () => {
  it("takes the id after the timestamp", () => {
    expect(piSessionIdFromPath(`/x/${REPO}/${A_FILE}`)).toBe(A);
    expect(piSessionIdFromPath("/x/2026-10-20T10-00-00-000Z_my_custom_id.jsonl")).toBe("my_custom_id");
    expect(piSessionIdFromPath("/x/no-id.jsonl")).toBeNull();
  });
});

describe("the pi reader", () => {
  it("lists only files that open with a session header", async () => {
    const list = await createPiReader().list(env);
    expect(list.map((s) => s.sessionId).sort()).toEqual([A, B, C]);
  });

  it("titles a Session by its latest session_info name, else its first prompt", async () => {
    const sessions = byId(await createPiReader().list(env));
    // The later name wins, trimmed.
    expect(sessions[A].title).toBe("Toast cleanup");
    // Text blocks joined as pi joins them; the image is not words.
    expect(sessions[A].firstPrompt).toBe("Fix the flaky toast test");
    // No name: the first prompt, on one line.
    expect(sessions[B].title).toBe("Write the scanner with tests");
    expect(sessions[B].firstPrompt).toBe("Write the scanner\n\nwith tests");
    // An empty name clears the one before it.
    expect(sessions[C].title).toBe("Why does the dropdown clip?");
  });

  it("takes the cwd from the header, not the lossy directory name", async () => {
    const sessions = byId(await createPiReader().list(env));
    expect(sessions[C].cwd).toBe("/home/u/work-my/repo-fix");
    expect(sessions[A].cwd).toBe("/home/u/work/my-repo");
  });

  it("names a fork's parent from the header's parentSession path", async () => {
    const sessions = byId(await createPiReader().list(env));
    expect(sessions[B].parentSessionId).toBe(A);
    expect(sessions[A].parentSessionId).toBeNull();
  });

  it("reads times, model and path", async () => {
    const path = join(dir, "pi/agent/sessions", REPO, A_FILE);
    const when = new Date("2026-10-25T09:30:00.000Z");
    await utimes(path, when, when);
    const sessions = byId(await createPiReader().list(env));
    expect(sessions[A]).toMatchObject({
      id: `pi:${A}`,
      hostId: "local",
      kind: "pi",
      createdAt: "2026-10-20T10:00:00.000Z",
      updatedAt: when.toISOString(),
      // The assistant's model beats the earlier model_change.
      model: "claude-opus-5",
      gitBranch: null,
      messageCount: null,
      path,
    });
    expect(sessions[B].model).toBe("gpt-5.5");
  });

  it("keeps a first prompt over 64 KB, and the name after a last line over 64 KB", async () => {
    const path = join(dir, "pi/agent/sessions", REPO, `2026-10-22T08-00-00-000Z_${D}.jsonl`);
    const line = (record: Record<string, unknown>) => `${JSON.stringify(record)}\n`;
    const message = (role: string, text: string) => line({ type: "message", message: { role, content: text } });
    await writeFile(
      path,
      line({ type: "session", version: 3, id: D, timestamp: "2026-10-22T08:00:00.000Z", cwd: "/w" }) +
        message("user", `long ${"p".repeat(100 * 1024)}`) +
        Array.from({ length: 600 }, (_, i) => message("assistant", `reply ${i} ${"x".repeat(200)}`)).join("") +
        line({ type: "session_info", name: "Big one" }) +
        message("assistant", "y".repeat(100 * 1024)),
    );
    const c = byId(await createPiReader().list(env))[D];
    expect(c.firstPrompt.startsWith("long ppp")).toBe(true);
    expect(c.title).toBe("Big one");
  });

  it("reads a custom session dir, where pi writes files flat", async () => {
    const flat = join(dir, "flat");
    await mkdir(flat);
    await rename(join(dir, "pi/agent/sessions", REPO, B_FILE), join(flat, B_FILE));
    const list = await createPiReader().list({ home: env.home, env: { PI_CODING_AGENT_SESSION_DIR: flat } });
    expect(list.map((s) => s.sessionId)).toEqual([B]);
  });

  it("reuses a file's summary while its size and mtime are unchanged", async () => {
    const reader = createPiReader();
    const path = join(dir, "pi/agent/sessions", REPO, A_FILE);
    const mtime = new Date("2026-10-25T09:30:00.000Z");
    await utimes(path, mtime, mtime);
    expect(byId(await reader.list(env))[A].title).toBe("Toast cleanup");

    const text = await readFile(path, "utf8");
    const renamed = text.replace("Toast cleanup", "Toast cleanuP");
    expect(renamed.length).toBe(text.length);
    await writeFile(path, renamed);
    await utimes(path, mtime, mtime);
    expect(byId(await reader.list(env))[A].title).toBe("Toast cleanup");

    const later = new Date(mtime.getTime() + 60_000);
    await utimes(path, later, later);
    expect(byId(await reader.list(env))[A].title).toBe("Toast cleanuP");
  });

  it("forgets a file that is gone", async () => {
    const reader = createPiReader();
    await reader.list(env);
    await rm(join(dir, "pi/agent/sessions", REPO, B_FILE));
    expect((await reader.list(env)).map((s) => s.sessionId).sort()).toEqual([A, C]);
  });

  it("lists nothing when there is no store", async () => {
    expect(await createPiReader().list({ home: join(dir, "nowhere"), env: {} })).toEqual([]);
  });
});

describe("summarizePiSession", () => {
  const header = { type: "session", version: 3, id: A, timestamp: "2026-10-28T10:00:00.000Z", cwd: "/w" };
  const user = (content: string) => ({ type: "message", message: { role: "user", content } });

  it("falls back to the first prompt when the name is outside the tail window", () => {
    const head = [header, user("first ask"), { type: "session_info", name: "Named mid-file" }];
    const tail = [user("a later ask")];
    expect(summarizePiSession(`/p/x_${A}.jsonl`, 0, head, tail)?.title).toBe("first ask");
  });

  it("is null for a file that does not open with a header", () => {
    expect(summarizePiSession(`/p/x_${A}.jsonl`, 0, [user("hi")], [user("hi")])).toBeNull();
  });
});
