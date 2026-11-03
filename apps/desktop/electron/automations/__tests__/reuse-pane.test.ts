/**
 * `createPaneSender` over fakes: when a same-pane run types, when it skips,
 * and when it leaves the run to a new tab. What the prompt must never land in
 * is the point: a shell, a dialog, a turn in progress.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

import { createPaneSender, type PaneSenderDeps } from "../reuse-pane";
import type { PaneFacts } from "../../terminal-host/types";
import type { Automation, AutomationPane, AutomationRun } from "../../../src/lib/automations";

const WORKSPACE = "/repo";
const NOW = Date.parse("2026-11-03T10:00:00.000Z");
const HOUR_AGO = new Date(NOW - 3_600_000).toISOString();

function automation(pane: AutomationPane = "fresh", overrides: Partial<Automation> = {}): Automation {
  return {
    id: "auto-1",
    name: "PR screener",
    enabled: true,
    schedule: { cron: "0 * * * *", timezone: "UTC" },
    projectId: "project-1",
    prompt: "Screen new PRs",
    agentKind: "claude",
    workspace: { mode: "reuse", workspacePath: WORKSPACE, pane },
    missedGraceMinutes: 720,
    createdAt: HOUR_AGO,
    updatedAt: HOUR_AGO,
    lastScheduledFor: HOUR_AGO,
    nextRunAt: null,
    ...overrides,
  };
}

const AT_PROMPT: PaneFacts = { foreground: { name: "claude", kind: "claude" }, title: null, outputHint: null };
const SHELL: PaneFacts = { foreground: null, title: null, outputHint: null };

describe("createPaneSender", () => {
  let run: AutomationRun | null;
  let facts: PaneFacts | null;
  let status: string | null;
  let root: string | null;
  let paneKind: string | null;
  let phase: string;
  let linked: string[][];
  let agents: Array<{ id: string; paneId: string; createdAt: string; status: string }>;
  let panes: string[];
  let typed: string[];
  let onTyped: (text: string) => void;
  let deps: PaneSenderDeps;

  beforeEach(() => {
    run = {
      id: "run-1",
      automationId: "auto-1",
      scheduledFor: HOUR_AGO,
      firedAt: HOUR_AGO,
      trigger: "schedule",
      outcome: "started",
      paneId: "pane-1",
      workspacePath: WORKSPACE,
    };
    facts = AT_PROMPT;
    status = "responded";
    root = "session-1";
    paneKind = null;
    phase = "responded";
    linked = [];
    agents = [{ id: "agent-1", paneId: "pane-1", createdAt: HOUR_AGO, status: "active" } as never];
    panes = ["pane-1"];
    typed = [];
    onTyped = () => {};
    deps = {
      agentManager: {
        getAgentById: (id: string) => agents.find((a) => a.id === id) ?? null,
        getAllAgents: () => agents,
        getAgentByPaneId: (paneId: string) => agents.find((a) => a.paneId === paneId) ?? null,
      },
      agentStatus: {
        getPaneState: () => (status === null && root === null ? undefined : { status, rootSessionId: root, kind: paneKind, phase, hookDriven: root !== null }),
      },
      lastStartedRun: () => run,
      linkRunAgent: (...args: string[]) => linked.push(args),
      layout: {
        get: () =>
          ({
            layout: {
              panels: {
                p: {
                  tabs: panes.map((paneId) => ({ rootNode: { type: "leaf", contentId: paneId, paneId } })),
                },
              },
            },
          }) as never,
      },
      paneFacts: vi.fn(async () => facts),
      typeIntoPane: vi.fn(async (_paneId: string, text: string) => {
        typed.push(text);
        onTyped(text);
      }),
      now: () => NOW,
      sleep: async () => {},
    } as unknown as PaneSenderDeps;
  });

  const send = (a = automation()) => createPaneSender(deps)(a, WORKSPACE);

  it("fresh clears, waits for the new session, then sends the prompt", async () => {
    onTyped = (text) => {
      if (text === "/clear") root = "session-2";
    };
    const result = await send();
    expect(typed).toEqual(["/clear", "Screen new PRs"]);
    // The clear retires the Agent; the run's is the one it makes.
    expect(result).toEqual({ outcome: "started", sentToPane: true, paneId: "pane-1", workspacePath: WORKSPACE });
  });

  it("fails rather than send when the clear never replaces the session", async () => {
    expect(await send()).toMatchObject({ outcome: "failed", reason: "error", paneId: "pane-1" });
    expect(typed).toEqual(["/clear"]);
  });

  it("fails rather than send when the clear started a turn instead", async () => {
    root = null;
    onTyped = () => {
      status = "working";
    };
    expect(await send()).toMatchObject({ outcome: "failed" });
    expect(typed).toEqual(["/clear"]);
  });

  it("names the last run's Agent before clearing takes it off the pane", async () => {
    onTyped = (text) => {
      if (text === "/clear") root = "session-2";
    };
    await send();
    expect(linked).toEqual([["auto-1", "run-1", "agent-1"]]);
  });

  it("uses each agent's own command", async () => {
    facts = { ...AT_PROMPT, foreground: { name: "codex", kind: "codex" } };
    onTyped = () => {
      root = "session-2";
    };
    await send(automation("fresh", { agentKind: "codex" }));
    expect(typed[0]).toBe("/new");
  });

  it("keep sends only the prompt and names the Agent it kept", async () => {
    const result = await send(automation("keep"));
    expect(typed).toEqual(["Screen new PRs"]);
    expect(result).toMatchObject({ outcome: "started", sentToPane: true, agentId: "agent-1" });
  });

  it.each([
    ["thinking", "still-working"],
    ["working", "still-working"],
    ["requires_input", "waiting-for-input"],
  ])("skips an agent that is %s, typing nothing", async (now, reason) => {
    status = now;
    expect(await send()).toMatchObject({
      outcome: "skipped",
      reason,
      detail: reason === "still-working" ? "The previous run is still working" : "The agent is waiting for input",
      paneId: "pane-1",
    });
    expect(typed).toEqual([]);
  });

  it("sends past an unknown process name while a session is still hook-driven", async () => {
    facts = { ...AT_PROMPT, foreground: { name: "myclaude", kind: null } };
    expect(await send(automation("keep"))).toMatchObject({ outcome: "started" });
  });

  it.each(["stalled", "active", "pendingStop"])("skips a turn in phase %s, whatever its status says", async (p) => {
    phase = p;
    expect(await send()).toMatchObject({ outcome: "skipped", reason: "still-working" });
    expect(typed).toEqual([]);
  });

  it("skips a pane whose state isn't known yet", async () => {
    status = null;
    root = null;
    expect(await send()).toMatchObject({ outcome: "skipped", reason: "agent-starting" });
    expect(typed).toEqual([]);
  });

  it("keep doesn't name an Agent that has finished", async () => {
    agents = [{ ...agents[0], status: "completed" } as never];
    const result = await send(automation("keep"));
    expect(result).toMatchObject({ outcome: "started" });
    expect(result).not.toHaveProperty("agentId");
  });

  it("skips a program the user runs in the pane rather than typing into it", async () => {
    facts = { ...AT_PROMPT, foreground: { name: "vim", kind: null } };
    root = null;
    expect(await send()).toMatchObject({ outcome: "skipped", reason: "still-working" });
    expect(typed).toEqual([]);
  });

  it.each<[string, () => void]>([
    ["no run has started yet", () => (run = null)],
    ["the tab was closed", () => (panes = [])],
    ["the host has no such session", () => (facts = null)],
    ["the agent exited to its shell", () => (facts = SHELL)],
    ["another kind of agent is there", () => (facts = { ...AT_PROMPT, foreground: { name: "codex", kind: "codex" } })],
    ["its session says another kind of agent", () => {
      facts = { ...AT_PROMPT, foreground: { name: "wrapper", kind: null } };
      paneKind = "codex";
    }],
    ["the last run was in another workspace", () => (run = { ...run!, workspacePath: "/elsewhere" })],
  ])("leaves it to a new tab when %s", async (_name, arrange) => {
    arrange();
    expect(await send()).toBeNull();
    expect(typed).toEqual([]);
  });

  it("waits for an agent still starting, in its shell or at its prompt", async () => {
    run = { ...run!, firedAt: new Date(NOW - 10_000).toISOString() };
    agents = [];
    for (const f of [SHELL, AT_PROMPT]) {
      facts = f;
      expect(await send()).toMatchObject({ outcome: "skipped", reason: "agent-starting" });
    }
    expect(typed).toEqual([]);
  });

  it("gives a launch up after a minute with no Agent record", async () => {
    run = { ...run!, firedAt: new Date(NOW - 61_000).toISOString() };
    agents = [];
    facts = SHELL;
    expect(await send()).toBeNull();
  });

  it("doesn't wait on a sent run whose clear made no new Agent", async () => {
    run = { ...run!, sentToPane: true, firedAt: new Date(NOW - 10_000).toISOString() };
    agents = [];
    expect(await send(automation("keep"))).toMatchObject({ outcome: "started" });
  });

  it("skips a second run right after a send", async () => {
    run = { ...run!, firedAt: new Date(NOW - 1_000).toISOString() };
    expect(await send(automation("keep"))).toMatchObject({ outcome: "skipped", reason: "agent-starting" });
  });

  it("a Run now during a send is skipped, so only one prompt is typed", async () => {
    let release = () => {};
    deps.sleep = () => new Promise<void>((resolve) => (release = resolve));
    const sender = createPaneSender(deps);
    root = null;
    status = "responded";
    const first = sender(automation(), WORKSPACE);
    await vi.waitFor(() => expect(typed).toEqual(["/clear"]));
    expect(await sender(automation(), WORKSPACE)).toMatchObject({ outcome: "skipped", reason: "agent-starting" });
    release();
    await first;
    expect(typed).toEqual(["/clear", "Screen new PRs"]);
  });
});
