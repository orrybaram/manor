import { describe, expect, it } from "vitest";
import type { AgentInfo } from "../../../../electron.d";
import { agentsModalRows } from "../agents-modal-list";

function agent(over: Partial<AgentInfo> & { id: string }): AgentInfo {
  return {
    name: null,
    projectName: null,
    workspacePath: null,
    paneId: null,
    status: "completed",
    createdAt: "2026-10-01T00:00:00Z",
    namePinned: false,
    ...over,
  } as AgentInfo;
}

const base = { searchAgents: [], query: "", tab: "all" as const, openPaneIds: new Set<string>(), liveTitles: {} };

describe("agentsModalRows", () => {
  it("Open lists only agents whose pane is in a workspace, whatever their lifecycle", () => {
    const storeAgents = [
      agent({ id: "stale", status: "active", paneId: "gone" }),
      agent({ id: "open", status: "completed", paneId: "p1" }),
      agent({ id: "none", status: "active" }),
    ];
    const openPaneIds = new Set(["p1"]);
    const ids = (tab: "all" | "open" | "closed") =>
      agentsModalRows({ ...base, storeAgents, openPaneIds, tab }).map((a) => a.id).sort();
    expect(ids("open")).toEqual(["open"]);
    expect(ids("closed")).toEqual(["none", "stale"]);
    expect(ids("all")).toEqual(["none", "open", "stale"]);
  });

  it("joins main's search page, keeps the store's copy, and filters both by the shown title", () => {
    const storeAgents = [
      agent({ id: "a", name: "old name", paneId: "p1", createdAt: "2026-10-03T00:00:00Z" }),
      agent({ id: "b", name: "unrelated", createdAt: "2026-10-02T00:00:00Z" }),
    ];
    const searchAgents = [
      agent({ id: "c", name: "toast deck", createdAt: "2026-09-01T00:00:00Z" }),
      agent({ id: "stale-page", name: "something else" }),
    ];
    const rows = agentsModalRows({
      ...base,
      storeAgents,
      searchAgents,
      query: "toast",
      liveTitles: { p1: "Toast stacking" },
    });
    expect(rows.map((a) => a.id)).toEqual(["a", "c"]);
  });
});
