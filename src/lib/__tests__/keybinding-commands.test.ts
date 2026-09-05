import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createSharedKeybindingHandlers,
  dispatchKeybinding,
  resolveWorkspaceCommand,
  startNewAgent,
} from "../keybinding-commands";
import { useAppStore } from "../../store/app-store";
import { useProjectStore } from "../../store/project-store";
import { useKeybindingsStore } from "../../store/keybindings-store";
import type { ProjectInfo } from "../../store/project-store";
import type { WorkspaceLayout, Tab, Panel } from "../../store/app-store";

const WS_PATH = "/test/workspace";

function makeLayout(tab: Tab): WorkspaceLayout {
  const panel: Panel = {
    id: "panel-1",
    tabs: [tab],
    selectedTabId: tab.id,
    pinnedTabIds: [],
  };
  return {
    panelTree: { type: "leaf", panelId: panel.id },
    panels: { [panel.id]: panel },
    activePanelId: panel.id,
  };
}

function singlePaneTab(): Tab {
  return {
    id: "tab-1",
    title: "Terminal",
    rootNode: { type: "leaf", paneId: "pane-1" },
    focusedPaneId: "pane-1",
  };
}

function makeProject(agentCommand: string): ProjectInfo {
  return {
    id: "proj-1",
    name: "Test",
    path: WS_PATH,
    agentCommand,
    selectedWorkspaceIndex: 0,
    workspaces: [
      {
        id: "ws-1",
        name: "main",
        path: WS_PATH,
        branch: "feature/xyz",
      },
    ],
  } as unknown as ProjectInfo;
}

function keyEvent(key: string, mods: Partial<KeyboardEvent> = {}) {
  return {
    key,
    metaKey: true,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    preventDefault: vi.fn(),
    ...mods,
  } as unknown as KeyboardEvent & { preventDefault: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  useProjectStore.setState({ projects: [], selectedProjectIndex: 0 });
  useAppStore.setState({
    activeWorkspacePath: WS_PATH,
    workspaceLayouts: { [WS_PATH]: makeLayout(singlePaneTab()) },
    paneCwd: {},
    paneTitle: {},
    paneAgentStatus: {},
    paneContentType: {},
    paneUrl: {},
    panePickedElement: {},
    closedPaneIds: new Set(),
    closedPaneStack: [],
    pendingStartupCommands: {},
    pendingPaneCommands: {},
    pendingCloseConfirmPaneId: null,
    pendingCloseConfirmTabId: null,
    webviewFocusedPaneId: null,
  });
});

describe("createSharedKeybindingHandlers", () => {
  // Regression guard for the popout gap: `DetachedApp` used to hand-roll a
  // subset of the handler map, so commands like new-agent and new-browser were
  // silently dead in a detached window. Both windows now build from this map.
  it("covers every command that is meaningful outside the primary window", () => {
    const handlers = createSharedKeybindingHandlers();
    for (const id of [
      "new-tab",
      "new-agent",
      "new-browser",
      "split-h",
      "split-v",
      "close-pane",
      "close-tab",
      "reopen-pane",
      "next-tab",
      "prev-tab",
      "next-pane",
      "prev-pane",
      "copy-branch",
      "split-panel-right",
      "split-panel-down",
      "focus-next-panel",
      "focus-prev-panel",
      "close-panel",
      "move-tab-to-next-panel",
      "browser-zoom-in",
      "browser-zoom-out",
      "browser-zoom-reset",
      "browser-reload",
      "browser-focus-url",
      "open-diff",
      "select-tab-1",
      "select-tab-9",
    ]) {
      expect(handlers[id], id).toBeTypeOf("function");
    }
  });

  it("leaves the primary-only commands to App", () => {
    const handlers = createSharedKeybindingHandlers();
    for (const id of [
      "settings",
      "command-palette",
      "toggle-sidebar",
      "new-workspace",
      "history-back",
      "history-forward",
    ]) {
      expect(handlers[id], id).toBeUndefined();
    }
  });

  it("new-browser opens a browser tab in the active panel", () => {
    createSharedKeybindingHandlers()["new-browser"]();
    const layout = useAppStore.getState().workspaceLayouts[WS_PATH];
    const panel = layout.panels[layout.activePanelId];
    expect(panel.tabs).toHaveLength(2);
    const paneId = panel.tabs[1].focusedPaneId;
    expect(useAppStore.getState().paneContentType[paneId]).toBe("browser");
  });
});

describe("resolveWorkspaceCommand", () => {
  it("uses the owning project's agent command", () => {
    useProjectStore.setState({ projects: [makeProject("my-agent --flag")] });
    expect(resolveWorkspaceCommand(WS_PATH)).toBe("my-agent --flag");
  });

  it("falls back to the default when no project owns the path", () => {
    expect(resolveWorkspaceCommand("/unknown")).toBeTruthy();
  });
});

describe("startNewAgent", () => {
  it("seeds the workspace's agent command and adds a tab without prewarm", async () => {
    useProjectStore.setState({ projects: [makeProject("my-agent")] });
    const consumePrewarmed = vi.fn();
    vi.stubGlobal("window", {
      ...window,
      electronAPI: { ...window.electronAPI, pty: { consumePrewarmed } },
    });

    await startNewAgent({ prewarm: false });

    expect(consumePrewarmed).not.toHaveBeenCalled();
    expect(useAppStore.getState().pendingStartupCommands[WS_PATH]).toBe(
      "my-agent",
    );
    const layout = useAppStore.getState().workspaceLayouts[WS_PATH];
    expect(layout.panels[layout.activePanelId].tabs).toHaveLength(2);
    vi.unstubAllGlobals();
  });

  it("adopts the prewarmed pane when prewarm is requested", async () => {
    useProjectStore.setState({ projects: [makeProject("my-agent")] });
    vi.stubGlobal("window", {
      ...window,
      electronAPI: {
        ...window.electronAPI,
        pty: {
          consumePrewarmed: vi
            .fn()
            .mockResolvedValue({ paneId: "pane-warm", commandInjected: true }),
        },
      },
    });

    await startNewAgent({ prewarm: true });

    // The command already ran in the prewarmed session — don't queue it again.
    expect(
      useAppStore.getState().pendingStartupCommands[WS_PATH],
    ).toBeUndefined();
    const layout = useAppStore.getState().workspaceLayouts[WS_PATH];
    const tabs = layout.panels[layout.activePanelId].tabs;
    expect(tabs[1].focusedPaneId).toBe("pane-warm");
    vi.unstubAllGlobals();
  });
});

describe("dispatchKeybinding", () => {
  it("runs the bound handler and swallows the event", () => {
    const newTab = vi.fn();
    const e = keyEvent(useKeybindingsStore.getState().bindings["new-tab"].key);
    dispatchKeybinding(e, { "new-tab": newTab });
    expect(newTab).toHaveBeenCalled();
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it("ignores modifier-less keys", () => {
    const newTab = vi.fn();
    const e = keyEvent("t", { metaKey: false });
    dispatchKeybinding(e, { "new-tab": newTab });
    expect(newTab).not.toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it("lets a command this window doesn't implement fall through", () => {
    // A popout has no command palette: Cmd+K must reach the native handling
    // rather than being preventDefault-ed into a no-op.
    const e = keyEvent(
      useKeybindingsStore.getState().bindings["command-palette"].key,
    );
    dispatchKeybinding(e, {});
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it("skips browser commands when the focused pane isn't a browser", () => {
    const zoomIn = vi.fn();
    const e = keyEvent(
      useKeybindingsStore.getState().bindings["browser-zoom-in"].key,
    );
    dispatchKeybinding(e, { "browser-zoom-in": zoomIn });
    expect(zoomIn).not.toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled();
  });
});
