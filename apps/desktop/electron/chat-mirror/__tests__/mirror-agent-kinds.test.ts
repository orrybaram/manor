import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claudeAdapter } from "../adapters/claude";
import { ChatMirror, type PaneAgent } from "../mirror";
import { LocalTranscriptSource } from "../transcript-source";

// Every kind reads as Claude's format here, standing in for the adapters
// still to come, so the per-kind rules are what is left to differ.
vi.mock("../adapters", () => ({ adapterFor: () => claudeAdapter }));

const PANE = "pane-1";
const T = "2026-01-01T00:00:00.000Z";

function plan(id: string): string {
  return (
    JSON.stringify({
      timestamp: T,
      type: "assistant",
      uuid: "a1",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id, name: "ExitPlanMode", input: { plan: "Do it" } }],
      },
    }) + "\n"
  );
}

describe("ChatMirror per agent kind", () => {
  let dir: string;
  let agent: PaneAgent | null;
  let writes: string[];
  let mirror: ChatMirror;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-mirror-kinds-"));
    writes = [];
    const transcriptPath = path.join(dir, "t.jsonl");
    fs.writeFileSync(transcriptPath, plan("p1"));
    agent = { hostId: "local", agentKind: "claude", transcriptPath };
    mirror = new ChatMirror({
      agentForPane: (paneId) => (paneId === PANE ? agent : null),
      write: (_paneId, data) => writes.push(data),
      publish: () => {},
      publishTask: () => {},
      sourceFor: () => new LocalTranscriptSource(),
    });
  });

  afterEach(() => {
    mirror.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("offers Claude's built-in commands only to Claude", async () => {
    const claude = await mirror.getCommands(PANE);
    expect(claude.ok && claude.commands.some((c) => c.name === "clear")).toBe(true);
    agent = { ...agent!, agentKind: "codex" };
    expect(await mirror.getCommands(PANE)).toEqual({ ok: true, commands: [], skillsKnown: true });
  });

  it("refuses to answer a picker for a kind whose pickers can't be typed, and types nothing", async () => {
    agent = { ...agent!, agentKind: "pi" };
    expect(await mirror.answer(PANE, "p1", { kind: "plan-approve" })).toEqual({
      ok: false,
      reason: "unsupported",
    });
    expect(writes).toEqual([]);
    agent = { ...agent, agentKind: "claude" };
    expect(await mirror.answer(PANE, "p1", { kind: "plan-approve" })).toEqual({ ok: true });
    expect(writes).toEqual(["\r"]);
  });

  it("types with the kind's interrupt keys, and as Claude for a pane with no agent", () => {
    expect(mirror.input(PANE).interruptKeys).toEqual(["\x1b"]);
    expect(mirror.input(PANE).promptWrites("a\r\nb")).toEqual(["a\nb", "\r"]);
    agent = { ...agent!, agentKind: "opencode" };
    expect(mirror.input(PANE).interruptKeys).toEqual(["\x1b", "\x1b"]);
    expect(mirror.input("other").interruptKeys).toEqual(["\x1b"]);
    expect(mirror.input("other").promptWrites("hi")).toEqual(["hi", "\r"]);
  });
});
