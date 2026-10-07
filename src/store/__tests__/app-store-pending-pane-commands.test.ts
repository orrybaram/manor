/**
 * Text queued for a pane's shell (ADR-183) lives on the Manor server since
 * ADR-179 ticket 11: the renderer queues it and whichever renderer creates
 * the pane's session has it typed. Typed-only text (`submit: false`, ADR-178
 * ticket 5's "fix in terminal") takes the same road. Dropping a closed pane's
 * entry is the server's too — see `electron/layout/__tests__/layout-store.test.ts`.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore, selectSelectedTabId } from "../app-store";
import type { Panel, WorkspaceLayout } from "../app-store";
import {
  queuedCommands,
  resetFakeLayoutServer,
  seedLayout,
  serverCalls,
  settled,
} from "./fake-layout-server";

// window is provided by the setup file (src/store/__tests__/setup.ts).

const WS_PATH = "/test/workspace";

/** One tab holding a split of pane-1 and pane-2. */
function makeLayout(): WorkspaceLayout {
  const panelId = "panel-1";
  const panel: Panel = {
    id: panelId,
    tabs: [
      {
        id: "tab-1",
        title: "Terminal",
        rootNode: {
          type: "split",
          direction: "horizontal",
          ratio: 0.5,
          first: { type: "leaf", paneId: "pane-1" },
          second: { type: "leaf", paneId: "pane-2" },
        },
      },
    ],
    pinnedTabIds: [],
  };
  return {
    panelTree: { type: "leaf", panelId },
    panels: { [panelId]: panel },
  };
}

function setupStore() {
  const layout = makeLayout();
  resetFakeLayoutServer();
  seedLayout(WS_PATH, layout);
  useAppStore.setState({
    activeWorkspacePath: WS_PATH,
    activeWorkspaceHostId: "local",
    workspaceLayouts: { [WS_PATH]: layout },
    layoutVersions: {},
    viewports: {},
    claims: {},
  });
}

describe("addTerminalTab with submit: false (ADR-178 ticket 5 — fix in terminal)", () => {
  beforeEach(() => setupStore());

  it("creates a new tab and queues the text, unsubmitted, before the tab", async () => {
    const result = useAppStore
      .getState()
      .addTerminalTab("claude setup-token", { submit: false });
    expect(result).not.toBeNull();
    // The tab arrives with the server's broadcast (ADR-182 D9).
    await settled();

    const panel = useAppStore.getState().workspaceLayouts[WS_PATH].panels["panel-1"];
    expect(panel.tabs).toHaveLength(2);
    expect(selectSelectedTabId(useAppStore.getState(), "panel-1")).toBe(result!.tabId);
    expect(queuedCommands).toEqual([
      { paneId: result!.paneId, text: "claude setup-token", kind: "shell", submit: false },
    ]);
    expect(serverCalls).toEqual(["pending", "apply"]);
  });

  it("submits by default", () => {
    const result = useAppStore.getState().addTerminalTab("pnpm dev");
    expect(queuedCommands).toEqual([
      { paneId: result!.paneId, text: "pnpm dev", kind: "shell" },
    ]);
  });

  it("passes an agent prompt beside the command (ADR-209)", () => {
    const result = useAppStore
      .getState()
      .addTerminalTab("claude", { kind: "agent-startup", prompt: 'say "hi"\nnow' });
    expect(queuedCommands).toEqual([
      {
        paneId: result!.paneId,
        text: "claude",
        kind: "agent-startup",
        prompt: 'say "hi"\nnow',
      },
    ]);
  });

  it("returns null, and queues nothing, when there is no active workspace", () => {
    useAppStore.setState({ activeWorkspacePath: null });
    expect(
      useAppStore.getState().addTerminalTab("gh auth login", { submit: false }),
    ).toBeNull();
    expect(queuedCommands).toEqual([]);
  });
});

describe("setPendingPaneCommand", () => {
  beforeEach(() => setupStore());

  it("queues on the server for a pane about to (re)create its session", () => {
    useAppStore.getState().setPendingPaneCommand("pane-1", "codex login", { submit: false });
    useAppStore.getState().setPendingPaneCommand("pane-2", "claude --resume s");
    expect(queuedCommands).toEqual([
      { paneId: "pane-1", text: "codex login", kind: "shell", submit: false },
      { paneId: "pane-2", text: "claude --resume s", kind: "shell" },
    ]);
  });
});
