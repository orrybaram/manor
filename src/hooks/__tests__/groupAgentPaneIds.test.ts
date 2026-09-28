import { describe, expect, it } from "vitest";
import { groupAgentPaneIds, layoutPaneIds } from "../useProjectAgentStatus";
import { pickBestPaneStatus } from "../useTabAgentStatus";
import type { WorkspaceLayout } from "../../store/app-store";
import { workspaceKey } from "../../lib/workspace-key";

/** A layout with one panel holding one tab per pane id. */
function layout(...paneIds: string[]): WorkspaceLayout {
  return {
    panelTree: { type: "leaf", panelId: "p1" },
    activePanelId: "p1",
    panels: {
      p1: {
        id: "p1",
        selectedTabId: "t0",
        pinnedTabIds: [],
        tabs: paneIds.map((paneId, i) => ({
          id: `t${i}`,
          title: "Terminal",
          rootNode: { type: "leaf", paneId },
          focusedPaneId: paneId,
        })),
      },
    },
  };
}

// One repo on this machine and on "box" (ADR-192), at different paths.
const localApp = { hostId: "local", workspaces: [{ path: "/Users/me/app" }] };
const boxApp = {
  hostId: "box",
  workspaces: [{ path: "/home/me/app" }, { path: "/home/me/.wt/app-feat" }],
};

describe("layoutPaneIds", () => {
  it("walks every tab of the given workspaces' layouts, skipping ones without", () => {
    expect(
      layoutPaneIds([workspaceKey("local", "/a"), workspaceKey("box", "/none"), workspaceKey("box", "/b")], {
        "/a": layout("x", "y"),
        [workspaceKey("box", "/b")]: layout("z"),
        // The same path on another host is another workspace.
        "/b": layout("not-this"),
      }),
    ).toEqual(["x", "y", "z"]);
  });
});

describe("groupAgentPaneIds", () => {
  it("collects the panes of every section's workspace layouts", () => {
    const ids = groupAgentPaneIds(
      [localApp, boxApp],
      { "/Users/me/app": layout("a"), [workspaceKey("box", "/home/me/.wt/app-feat")]: layout("b", "c") },
      [],
    );
    expect(ids.sort()).toEqual(["a", "b", "c"]);
  });

  it("reads each member's layouts on its own host when the paths match", () => {
    // Linked members at the very same path: each section's layout is its own.
    const shared = "/home/me/app";
    const members = [
      { hostId: "local", workspaces: [{ path: shared }] },
      { hostId: "box", workspaces: [{ path: shared }] },
    ];
    const layouts = {
      [workspaceKey("local", shared)]: layout("on-local"),
      [workspaceKey("box", shared)]: layout("on-box"),
      [workspaceKey("vm", shared)]: layout("on-vm"),
    };
    expect(groupAgentPaneIds(members, layouts, []).sort()).toEqual(["on-box", "on-local"]);
    expect(groupAgentPaneIds([members[1]], layouts, [])).toEqual(["on-box"]);
  });

  it("counts an agent on any section's host by its own hostId", () => {
    const ids = groupAgentPaneIds([localApp, boxApp], {}, [
      { hostId: "box", workspacePath: "/home/me/.wt/app-feat", paneId: "remote-agent" },
      { hostId: "local", workspacePath: "/Users/me/app", paneId: "local-agent" },
    ]);
    expect(ids.sort()).toEqual(["local-agent", "remote-agent"]);
  });

  it("ignores an agent at a member's path on a host that is not that member's", () => {
    // Same path as box's workspace, but the terminal runs on this machine,
    // where no member of the group lives at that path.
    const ids = groupAgentPaneIds([localApp, boxApp], {}, [
      { hostId: "local", workspacePath: "/home/me/app", paneId: "stray" },
      { hostId: "other", workspacePath: "/Users/me/app", paneId: "elsewhere" },
    ]);
    expect(ids).toEqual([]);
  });

  it("reads a missing member host as this machine", () => {
    const ids = groupAgentPaneIds(
      [{ hostId: undefined, workspaces: [{ path: "/Users/me/app" }] }],
      {},
      [{ hostId: "local", workspacePath: "/Users/me/app", paneId: "a" }],
    );
    expect(ids).toEqual(["a"]);
  });

  it("does not count a pane twice when an agent's pane is also in a layout", () => {
    const ids = groupAgentPaneIds([boxApp], { [workspaceKey("box", "/home/me/app")]: layout("a") }, [
      { hostId: "box", workspacePath: "/home/me/app", paneId: "a" },
    ]);
    expect(ids).toEqual(["a"]);
  });

  it("lets the collapsed group show an agent waiting on the remote section", () => {
    const ids = groupAgentPaneIds([localApp, boxApp], { "/Users/me/app": layout("a") }, [
      { hostId: "box", workspacePath: "/home/me/app", paneId: "remote" },
    ]);
    const result = pickBestPaneStatus(ids, {
      paneAgentStatus: {
        a: { status: "working", reason: "test", kind: "claude" },
        remote: { status: "requires_input", reason: "test", kind: "claude" },
      },
      agents: [],
      unseenRespondedAgentIds: new Set(),
      unseenInputAgentIds: new Set(),
    });
    expect(result.status).toBe("requires_input");
  });
});
