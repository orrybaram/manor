import { describe, it, expect, vi } from "vitest";

vi.mock("../../store/app-store", () => ({ useAppStore: vi.fn() }));

import { resolveAgentTitle } from "../useAgentDisplay";
import type { AgentInfo } from "../../electron.d";

function agent(overrides: Partial<AgentInfo>): AgentInfo {
  return {
    id: "a1",
    agentSessionId: "s1",
    name: null,
    status: "active",
    createdAt: "",
    updatedAt: "",
    completedAt: null,
    activatedAt: null,
    projectId: null,
    projectName: null,
    workspacePath: null,
    cwd: "/",
    agentKind: "claude",
    agentCommand: null,
    paneId: "p1",
    lastAgentStatus: null,
    resumedAt: null,
    ...overrides,
  };
}

describe("resolveAgentTitle", () => {
  it("prefers the live terminal title when no name is pinned", () => {
    expect(resolveAgentTitle(agent({ name: "Synced" }), "✳ Live title")).toBe(
      "Live title",
    );
  });

  it("falls back to the persisted name, then a generic label", () => {
    expect(resolveAgentTitle(agent({ name: "Synced" }), null)).toBe("Synced");
    expect(resolveAgentTitle(agent({}), "claude")).toBe("Agent");
  });

  it("lets a pinned user name win over the live title", () => {
    expect(
      resolveAgentTitle(agent({ name: "Mine", namePinned: true }), "Live title"),
    ).toBe("Mine");
  });

  it("ignores the pin when the name was cleared", () => {
    expect(
      resolveAgentTitle(agent({ name: null, namePinned: true }), "Live title"),
    ).toBe("Live title");
  });
});
