import { describe, it, expect, vi } from "vitest";
import {
  agentToResume,
  planHostResume,
  recoverHostPanes,
  restartNotice,
  type RecoveryEffects,
} from "../remote-recovery";
import type { AgentInfo } from "../../electron.d";

function agent(overrides: Partial<AgentInfo>): AgentInfo {
  return {
    id: "agent-1",
    agentSessionId: "sess-1",
    name: null,
    status: "active",
    createdAt: "",
    updatedAt: "",
    completedAt: null,
    activatedAt: null,
    projectId: null,
    projectName: null,
    workspacePath: null,
    cwd: "/srv/repo",
    agentKind: "claude",
    agentCommand: "claude",
    paneId: "p-lost-agent",
    lastAgentStatus: null,
    resumedAt: null,
    ...overrides,
  };
}

describe("planHostResume", () => {
  it("splits this window's panes on the host into survivors and lost", () => {
    const plan = planHostResume(
      "box",
      { a: "box", b: "box", c: "other" },
      ["a", "c", "unrelated"],
    );
    expect(plan).toEqual({ reattach: ["a"], lost: ["b"] });
  });

  it("has nothing to do for a host this window has no panes on", () => {
    expect(planHostResume("box", { a: "other" }, [])).toEqual({ reattach: [], lost: [] });
  });
});

describe("agentToResume", () => {
  it("resumes the pane's active agent, even one resumed before", () => {
    const a = agent({ resumedAt: "2026-01-01" });
    expect(agentToResume("p-lost-agent", [a])).toBe(a);
  });

  it("skips finished agents, other panes and agents with nothing to relaunch", () => {
    expect(agentToResume("p-lost-agent", [agent({ status: "completed" })])).toBeNull();
    expect(agentToResume("p-lost-agent", [agent({ paneId: "elsewhere" })])).toBeNull();
    expect(agentToResume("p-lost-agent", [agent({ agentCommand: null })])).toBeNull();
  });
});

describe("restartNotice", () => {
  it("counts sessions", () => {
    expect(restartNotice(1)).toBe("Remote host restarted — 1 session resumed");
    expect(restartNotice(3)).toBe("Remote host restarted — 3 sessions resumed");
  });
});

describe("recoverHostPanes", () => {
  function effects(overrides: Partial<RecoveryEffects> = {}) {
    const order: string[] = [];
    const fx: RecoveryEffects = {
      remoteHostByPane: () => ({
        "p-alive": "box",
        "p-lost-agent": "box",
        "p-lost-shell": "box",
        "p-other": "other",
      }),
      getActiveAgents: vi.fn(async () => [agent({})]),
      markResumed: vi.fn(async () => null),
      buildResumeCommand: vi.fn(async () => "claude --resume sess-1"),
      setPendingPaneCommand: vi.fn((paneId: string, command: string) => {
        order.push(`command ${paneId} ${command}`);
      }),
      reattach: vi.fn((paneIds: string[]) => {
        order.push(`reattach ${paneIds.join(",")}`);
      }),
      notify: vi.fn(),
      ...overrides,
    };
    return { fx, order };
  }

  it("reattaches survivors, and recreates lost panes with their agent's resume command queued first", async () => {
    const { fx, order } = effects();
    const plan = await recoverHostPanes("box", ["p-alive"], fx);

    expect(plan).toEqual({ reattach: ["p-alive"], lost: ["p-lost-agent", "p-lost-shell"] });
    expect(order).toEqual([
      "reattach p-alive",
      "command p-lost-agent claude --resume sess-1",
      "reattach p-lost-agent,p-lost-shell",
    ]);
    expect(fx.markResumed).toHaveBeenCalledWith("agent-1");
    // A pane without an agent just gets a fresh shell: nothing queued.
    expect(fx.setPendingPaneCommand).toHaveBeenCalledTimes(1);
    expect(fx.notify).toHaveBeenCalledTimes(1);
    expect(fx.notify).toHaveBeenCalledWith("Remote host restarted — 2 sessions resumed");
  });

  it("says nothing and looks up no agents when every session survived", async () => {
    const { fx } = effects({
      remoteHostByPane: () => ({ "p-alive": "box" }),
    });
    await recoverHostPanes("box", ["p-alive"], fx);
    expect(fx.reattach).toHaveBeenCalledWith(["p-alive"]);
    expect(fx.getActiveAgents).not.toHaveBeenCalled();
    expect(fx.notify).not.toHaveBeenCalled();
  });

  it("falls back to the bare agent command when no resume command can be built", async () => {
    const { fx } = effects({ buildResumeCommand: vi.fn(async () => null) });
    await recoverHostPanes("box", ["p-alive"], fx);
    expect(fx.setPendingPaneCommand).toHaveBeenCalledWith("p-lost-agent", "claude");
  });

  it("still recovers lost panes as bare shells if agents cannot be listed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fx } = effects({
      getActiveAgents: vi.fn(async () => {
        throw new Error("ipc down");
      }),
    });
    await recoverHostPanes("box", ["p-alive"], fx);
    expect(fx.setPendingPaneCommand).not.toHaveBeenCalled();
    expect(fx.reattach).toHaveBeenLastCalledWith(["p-lost-agent", "p-lost-shell"]);
    warn.mockRestore();
  });
});
