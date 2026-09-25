import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createSharedKeybindingHandlers,
  dispatchKeybinding,
  resolveWorkspaceCommand,
  runForwardedCommand,
  startNewAgent,
} from "../keybinding-commands";
import {
  registerBrowserPane,
  unregisterBrowserPane,
} from "../browser-pane-registry";
import type { BrowserPaneRef } from "../../components/workspace-panes/BrowserPane/BrowserPane";
import { MAIN_WINDOW_KEYBINDINGS } from "../menu-commands";
import { useAppStore } from "../../store/app-store";
import { useProjectStore } from "../../store/project-store";
import { useKeybindingsStore } from "../../store/keybindings-store";
import { SHARED_WINDOW_COMMANDS } from "../menu-commands";
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
      "focus-next-region",
      "focus-prev-region",
      "focus-tabbar",
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
      "focus-sidebar",
    ]) {
      expect(handlers[id], id).toBeUndefined();
    }
  });

  // Main routes a menu command to the focused window only when that window can
  // service it, and it reads `SHARED_WINDOW_COMMANDS` (a DOM-free copy) to know.
  // If the two drift, menu items silently no-op in a popout.
  it("keeps MAIN_WINDOW_KEYBINDINGS out of the shared map", () => {
    const handlers = createSharedKeybindingHandlers();
    for (const id of MAIN_WINDOW_KEYBINDINGS) {
      expect(handlers[id], id).toBeUndefined();
    }
  });

  it("matches SHARED_WINDOW_COMMANDS exactly", () => {
    const ids = new Set(Object.keys(createSharedKeybindingHandlers()));
    expect([...ids].sort()).toEqual([...SHARED_WINDOW_COMMANDS].sort());
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

    // The prewarmed session is consumed for the active workspace's cwd, so
    // the main process can reject a stale (e.g. wrong-host) prewarm.
    expect(
      window.electronAPI.pty.consumePrewarmed,
    ).toHaveBeenCalledWith(WS_PATH);

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

  it("dispatches a bound function key without a modifier", () => {
    const next = vi.fn();
    const e = keyEvent("F6", { metaKey: false });
    dispatchKeybinding(e, { "focus-next-region": next });
    expect(next).toHaveBeenCalled();
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it("dispatches Shift+F6 to the previous-region command", () => {
    const next = vi.fn();
    const prev = vi.fn();
    const e = keyEvent("F6", { metaKey: false, shiftKey: true });
    dispatchKeybinding(e, {
      "focus-next-region": next,
      "focus-prev-region": prev,
    });
    expect(prev).toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it("ignores an unbound function key", () => {
    const e = keyEvent("F7", { metaKey: false });
    dispatchKeybinding(e, { "focus-next-region": vi.fn() });
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it("matches a shifted letter whatever its case", () => {
    const focusSidebar = vi.fn();
    const e = keyEvent("E", { shiftKey: true });
    dispatchKeybinding(e, { "focus-sidebar": focusSidebar });
    expect(focusSidebar).toHaveBeenCalled();
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

  describe("with a modal dialog open", () => {
    /** Stub `document.querySelector` to report one open Radix dialog. */
    function stubOpenDialog(testId: string) {
      vi.stubGlobal("document", {
        querySelector: (selector: string) =>
          selector.includes('[role="dialog"]')
            ? { getAttribute: () => testId }
            : null,
      });
    }

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("blocks a command behind the settings modal", () => {
      stubOpenDialog("settings-modal");
      const newTab = vi.fn();
      const e = keyEvent(useKeybindingsStore.getState().bindings["new-tab"].key);
      dispatchKeybinding(e, { "new-tab": newTab });
      expect(newTab).not.toHaveBeenCalled();
      expect(e.preventDefault).not.toHaveBeenCalled();
    });

    it("still lets ⌘, close the settings modal", () => {
      stubOpenDialog("settings-modal");
      const settings = vi.fn();
      const e = keyEvent(useKeybindingsStore.getState().bindings["settings"].key);
      dispatchKeybinding(e, { settings });
      expect(settings).toHaveBeenCalled();
      expect(e.preventDefault).toHaveBeenCalled();
    });

    it("blocks the palette toggle while settings (not the palette) is open", () => {
      stubOpenDialog("settings-modal");
      const togglePalette = vi.fn();
      const e = keyEvent(
        useKeybindingsStore.getState().bindings["command-palette"].key,
      );
      dispatchKeybinding(e, { "command-palette": togglePalette });
      expect(togglePalette).not.toHaveBeenCalled();
    });

    it("still lets ⌘K close the command palette", () => {
      stubOpenDialog("command-palette");
      const togglePalette = vi.fn();
      const e = keyEvent(
        useKeybindingsStore.getState().bindings["command-palette"].key,
      );
      dispatchKeybinding(e, { "command-palette": togglePalette });
      expect(togglePalette).toHaveBeenCalled();
    });

    it("blocks a command behind a dialog with no toggle of its own", () => {
      stubOpenDialog("agents-modal");
      const newTab = vi.fn();
      const e = keyEvent(useKeybindingsStore.getState().bindings["new-tab"].key);
      dispatchKeybinding(e, { "new-tab": newTab });
      expect(newTab).not.toHaveBeenCalled();
    });
  });
});

/** Make pane-1 a registered browser pane and return its ref's spies. */
function focusBrowserPane() {
  useAppStore.setState({ paneContentType: { "pane-1": "browser" } });
  const ref = {
    goBack: vi.fn(),
    goForward: vi.fn(),
  } as unknown as BrowserPaneRef & {
    goBack: ReturnType<typeof vi.fn>;
    goForward: ReturnType<typeof vi.fn>;
  };
  registerBrowserPane("pane-1", ref);
  return ref;
}

/** Stub `document` with `activeElement` inside the pane with `paneId`. */
function stubFocusInPane(paneId: string, tagName = "INPUT") {
  const blur = vi.fn();
  vi.stubGlobal("document", {
    querySelector: () => null,
    activeElement: {
      tagName,
      blur,
      closest: (sel: string) =>
        sel === "[data-pane-id]" ? { getAttribute: () => paneId } : null,
    },
  });
  return blur;
}

describe("dispatchKeybinding — browser pane chrome", () => {
  afterEach(() => {
    unregisterBrowserPane("pane-1");
    vi.unstubAllGlobals();
  });

  it("⌘] means forward, not next pane, while the URL bar has focus", () => {
    const ref = focusBrowserPane();
    stubFocusInPane("pane-1");
    const nextPane = vi.fn();
    const e = keyEvent("]");
    dispatchKeybinding(e, {
      ...createSharedKeybindingHandlers(),
      "next-pane": nextPane,
    });
    expect(ref.goForward).toHaveBeenCalled();
    expect(nextPane).not.toHaveBeenCalled();
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it("⌘[ means back while the URL bar has focus", () => {
    const ref = focusBrowserPane();
    stubFocusInPane("pane-1");
    const prevPane = vi.fn();
    dispatchKeybinding(keyEvent("["), {
      ...createSharedKeybindingHandlers(),
      "prev-pane": prevPane,
    });
    expect(ref.goBack).toHaveBeenCalled();
    expect(prevPane).not.toHaveBeenCalled();
  });

  it("⌘F runs find in page from the URL bar", () => {
    focusBrowserPane();
    stubFocusInPane("pane-1");
    const find = vi.fn();
    const e = keyEvent("f");
    dispatchKeybinding(e, { "browser-find": find });
    expect(find).toHaveBeenCalled();
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it("keeps ⌘] as next pane when focus is outside the browser pane", () => {
    const ref = focusBrowserPane();
    stubFocusInPane("pane-2");
    const nextPane = vi.fn();
    dispatchKeybinding(keyEvent("]"), {
      ...createSharedKeybindingHandlers(),
      "next-pane": nextPane,
    });
    expect(nextPane).toHaveBeenCalled();
    expect(ref.goForward).not.toHaveBeenCalled();
  });
});

describe("dispatchKeybinding — fallback", () => {
  it("hands an unimplemented command to the fallback", () => {
    const fallback = vi.fn(() => true);
    const e = keyEvent("k");
    dispatchKeybinding(e, {}, { fallback });
    expect(fallback).toHaveBeenCalledWith("command-palette");
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it("lets the key through when the fallback declines", () => {
    const e = keyEvent("k");
    dispatchKeybinding(e, {}, { fallback: () => false });
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it("does not consult the fallback for an implemented command", () => {
    const fallback = vi.fn(() => true);
    const newTab = vi.fn();
    dispatchKeybinding(keyEvent("t"), { "new-tab": newTab }, { fallback });
    expect(newTab).toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
  });
});

describe("runForwardedCommand", () => {
  afterEach(() => {
    unregisterBrowserPane("pane-1");
    vi.unstubAllGlobals();
  });

  it("runs the named handler", () => {
    const palette = vi.fn();
    runForwardedCommand(
      { commandId: "command-palette", source: "webview", paneId: "pane-1" },
      { "command-palette": palette },
    );
    expect(palette).toHaveBeenCalled();
  });

  it("respects the modal scope", () => {
    vi.stubGlobal("document", {
      querySelector: (selector: string) =>
        selector.includes('[role="dialog"]')
          ? { getAttribute: () => "settings-modal" }
          : null,
    });
    const newTab = vi.fn();
    const settings = vi.fn();
    const handlers = { "new-tab": newTab, settings };
    runForwardedCommand({ commandId: "new-tab", source: "popout" }, handlers);
    runForwardedCommand({ commandId: "settings", source: "popout" }, handlers);
    expect(newTab).not.toHaveBeenCalled();
    expect(settings).toHaveBeenCalled();
  });

  it("skips browser commands with no browser focused", () => {
    const reload = vi.fn();
    runForwardedCommand(
      { commandId: "browser-reload", source: "webview" },
      { "browser-reload": reload },
    );
    expect(reload).not.toHaveBeenCalled();
  });

  it("hands a command this window lacks to the fallback", () => {
    const fallback = vi.fn(() => true);
    runForwardedCommand(
      { commandId: "settings", source: "webview" },
      {},
      { fallback },
    );
    expect(fallback).toHaveBeenCalledWith("settings");
  });

  it("blurs the page before moving focus to the tab bar", () => {
    const blur = stubFocusInPane("pane-1", "WEBVIEW");
    const focusTabbar = vi.fn();
    runForwardedCommand(
      { commandId: "focus-tabbar", source: "webview", paneId: "pane-1" },
      { "focus-tabbar": focusTabbar },
    );
    expect(blur).toHaveBeenCalled();
    expect(focusTabbar).toHaveBeenCalled();
  });

  it("leaves the page focused for other commands", () => {
    const blur = stubFocusInPane("pane-1", "WEBVIEW");
    const newTab = vi.fn();
    runForwardedCommand(
      { commandId: "new-tab", source: "webview", paneId: "pane-1" },
      { "new-tab": newTab },
    );
    expect(blur).not.toHaveBeenCalled();
    expect(newTab).toHaveBeenCalled();
  });
});
