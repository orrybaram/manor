import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  useAppStore,
  selectCurrentLocation,
  type AppState,
  type WorkspaceLayout,
  type Tab,
  type Panel,
} from "../store/app-store";
import { useProjectStore } from "../store/project-store";
import {
  useNavigationHistoryStore,
  locationsEqual,
  type Location,
} from "../store/navigation-history-store";
import { navigateBack, navigateForward } from "./useNavigationHistory";
import { workspaceKey, type WorkspaceKey } from "../lib/workspace-key";

// window is provided by the setup file (src/store/__tests__/setup.ts)

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WS_A = "/test/ws-a";
const WS_B = "/test/ws-b";

function makeLayout(panelId: string, tabId: string): WorkspaceLayout {
  const paneId = `${tabId}-pane`;
  const tab: Tab = {
    id: tabId,
    title: "Terminal",
    rootNode: { type: "leaf", paneId },
  };
  const panel: Panel = {
    id: panelId,
    tabs: [tab],
    pinnedTabIds: [],
  };
  return {
    panelTree: { type: "leaf", panelId },
    panels: { [panelId]: panel },
  };
}

function seedStore(overrides?: Partial<AppState>) {
  useAppStore.setState({
    activeWorkspacePath: null,
    activeWorkspaceHostId: "local",
    workspaceLayouts: {
      [WS_A]: makeLayout("panel-a", "tab-a"),
      [WS_B]: makeLayout("panel-b", "tab-b"),
    },
    paneCwd: {},
    paneTitle: {},
    paneAgentStatus: {},
    paneLiveUrl: {},
    panePickedElement: {},
    paneFavicon: {},
    paneAudioPlaying: {},
    paneAudioMuted: {},
    pendingCloseConfirmPaneId: null,
    pendingCloseConfirmTabId: null,
    webviewFocusedPaneId: null,
    ...overrides,
  });
}

const locA: Location = {
  kind: "workspace",
  workspaceKey: WS_A as WorkspaceKey,
  panelId: "panel-a",
  tabId: "tab-a",
};
const locB: Location = {
  kind: "workspace",
  workspaceKey: WS_B as WorkspaceKey,
  panelId: "panel-b",
  tabId: "tab-b",
};

/** Mirror the recorder subscription set up by `useNavigationHistory`. */
function attachRecorder(): () => void {
  let previous = selectCurrentLocation(useAppStore.getState());
  useNavigationHistoryStore.getState().record(previous);
  return useAppStore.subscribe((state) => {
    const next = selectCurrentLocation(state);
    if (locationsEqual(previous, next)) return;
    previous = next;
    if (useNavigationHistoryStore.getState().isNavigating) return;
    useNavigationHistoryStore.getState().record(next);
  });
}

const flushMicrotasks = () => new Promise<void>((r) => queueMicrotask(() => r()));

beforeEach(() => {
  useNavigationHistoryStore.setState({
    entries: [],
    index: -1,
    isNavigating: false,
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("selectCurrentLocation", () => {
  it("returns the home surface when there is no active workspace", () => {
    seedStore({ activeWorkspacePath: null });
    expect(selectCurrentLocation(useAppStore.getState())).toEqual({
      kind: "surface",
      surface: "home",
    });
  });

  it("returns the home surface for the Home sentinel path", () => {
    seedStore({ activeWorkspacePath: "__home__" });
    expect(selectCurrentLocation(useAppStore.getState())).toEqual({
      kind: "surface",
      surface: "home",
    });
  });

  it("maps an active workspace to its active panel's selected tab", () => {
    seedStore({ activeWorkspacePath: WS_A });
    expect(selectCurrentLocation(useAppStore.getState())).toEqual(locA);
  });
});

describe("navigator bridge — feedback loop guard", () => {
  it("navigateBack replays without growing history", async () => {
    // Drive real navigation so history is populated by the recorder itself.
    seedStore({ activeWorkspacePath: WS_A });
    const detach = attachRecorder();
    try {
      useAppStore.getState().setActiveWorkspace(WS_B);
      // Two distinct locations recorded, currently at B.
      expect(useNavigationHistoryStore.getState().entries).toEqual([
        locA,
        locB,
      ]);
      expect(useNavigationHistoryStore.getState().index).toBe(1);

      navigateBack();
      await flushMicrotasks();

      // The app moved back to A, but the recorder must NOT have appended a new
      // entry — replaying history must never grow it.
      expect(useAppStore.getState().activeWorkspacePath).toBe(WS_A);
      expect(useNavigationHistoryStore.getState().entries).toEqual([
        locA,
        locB,
      ]);
      expect(useNavigationHistoryStore.getState().index).toBe(0);
      expect(useNavigationHistoryStore.getState().isNavigating).toBe(false);

      // Forward again — still no growth.
      navigateForward();
      await flushMicrotasks();
      expect(useAppStore.getState().activeWorkspacePath).toBe(WS_B);
      expect(useNavigationHistoryStore.getState().entries).toEqual([
        locA,
        locB,
      ]);
      expect(useNavigationHistoryStore.getState().index).toBe(1);
    } finally {
      detach();
    }
  });
});

describe("navigator bridge — prune", () => {
  it("drops stale entries and applies the nearest valid one going back", async () => {
    seedStore({ activeWorkspacePath: WS_B });
    const stale: Location = {
      kind: "workspace",
      workspaceKey: "/gone" as WorkspaceKey,
      panelId: "panel-x",
      tabId: "tab-x",
    };
    useNavigationHistoryStore.setState({
      entries: [locA, stale, locB],
      index: 2,
      isNavigating: false,
    });

    navigateBack();
    await flushMicrotasks();

    // The stale middle entry is pruned; navigation lands on A.
    expect(useNavigationHistoryStore.getState().entries).toEqual([locA, locB]);
    expect(useNavigationHistoryStore.getState().index).toBe(0);
    expect(useAppStore.getState().activeWorkspacePath).toBe(WS_A);
  });

  it("stops without navigating when nothing valid remains", async () => {
    seedStore({ activeWorkspacePath: WS_B });
    const stale: Location = {
      kind: "workspace",
      workspaceKey: "/gone" as WorkspaceKey,
      panelId: "panel-x",
      tabId: "tab-x",
    };
    useNavigationHistoryStore.setState({
      entries: [stale, locB],
      index: 1,
      isNavigating: false,
    });

    navigateBack();
    await flushMicrotasks();

    // Only stale entries behind us — prune them, stay put, do not navigate.
    expect(useAppStore.getState().activeWorkspacePath).toBe(WS_B);
    expect(useNavigationHistoryStore.getState().isNavigating).toBe(false);
  });

  it("does NOT prune an empty-workspace view (tabId '') going back", async () => {
    // An empty workspace has a panel with no tabs; its recorded tabId is "".
    // This must remain navigable — regression for empty workspaces being
    // silently skipped on back/forward.
    const WS_EMPTY = "/test/ws-empty";
    const emptyLayout: WorkspaceLayout = {
      panelTree: { type: "leaf", panelId: "panel-empty" },
      panels: {
        "panel-empty": {
          id: "panel-empty",
          tabs: [],
          pinnedTabIds: [],
        },
      },
    };
    const emptyLoc: Location = {
      kind: "workspace",
      workspaceKey: WS_EMPTY as WorkspaceKey,
      panelId: "panel-empty",
      tabId: "",
    };

    seedStore({
      activeWorkspacePath: WS_B,
      workspaceLayouts: {
        [WS_A]: makeLayout("panel-a", "tab-a"),
        [WS_B]: makeLayout("panel-b", "tab-b"),
        [WS_EMPTY]: emptyLayout,
      },
    });
    useNavigationHistoryStore.setState({
      entries: [locA, emptyLoc, locB],
      index: 2,
      isNavigating: false,
    });

    navigateBack();
    await flushMicrotasks();

    // Back lands on the empty workspace — it is a real view, not stale.
    expect(useNavigationHistoryStore.getState().entries).toEqual([
      locA,
      emptyLoc,
      locB,
    ]);
    expect(useNavigationHistoryStore.getState().index).toBe(1);
    expect(useAppStore.getState().activeWorkspacePath).toBe(WS_EMPTY);
  });
});

describe("navigator bridge — project-store sync", () => {
  it("moves the project-store selection so the sidebar follows the replay", () => {
    // Sidebar highlighting is driven by project-store selection, not
    // `activeWorkspacePath`. Replay must update it or the sidebar stays put
    // and (between look-alike workspaces) the app appears not to navigate.
    const selectWorkspaceSpy = vi.fn();
    vi.stubGlobal("window", {
      ...(globalThis as unknown as { window: Record<string, unknown> }).window,
      electronAPI: {
        ...((globalThis as unknown as { window: { electronAPI?: object } })
          .window?.electronAPI ?? {}),
        projects: { selectWorkspace: selectWorkspaceSpy, select: vi.fn() },
      },
    });

    seedStore({ activeWorkspacePath: WS_B });
    useProjectStore.setState({
      selectedProjectIndex: 0,
      projects: [
        {
          id: "proj-1",
          name: "proj",
          path: "/test",
          defaultBranch: "main",
          selectedWorkspaceIndex: 1, // currently on WS_B
          workspaces: [
            { path: WS_A, branch: "a", isMain: true, name: null },
            { path: WS_B, branch: "b", isMain: false, name: null },
          ],
        },
      ],
    } as never);
    useNavigationHistoryStore.setState({
      entries: [locA, locB],
      index: 1,
      isNavigating: false,
    });

    navigateBack();

    // Selection followed to WS_A (index 0), via the same path the sidebar uses.
    expect(selectWorkspaceSpy).toHaveBeenCalledWith("proj-1", 0);
    expect(useProjectStore.getState().projects[0].selectedWorkspaceIndex).toBe(
      0,
    );
    expect(useAppStore.getState().activeWorkspacePath).toBe(WS_A);
  });
});

describe("navigator bridge — hosts (ADR-191)", () => {
  it("goes back to the workspace on its own host when another host has the same path", async () => {
    const selectWorkspaceSpy = vi.fn();
    vi.stubGlobal("window", {
      ...(globalThis as unknown as { window: Record<string, unknown> }).window,
      electronAPI: {
        ...((globalThis as unknown as { window: { electronAPI?: object } })
          .window?.electronAPI ?? {}),
        projects: { selectWorkspace: selectWorkspaceSpy, select: vi.fn() },
      },
    });
    const remoteKey = workspaceKey("box", WS_A);
    seedStore({
      activeWorkspacePath: WS_B,
      activeWorkspaceHostId: "local",
      workspaceLayouts: {
        [WS_A]: makeLayout("panel-a", "tab-a"),
        [WS_B]: makeLayout("panel-b", "tab-b"),
        [remoteKey]: makeLayout("panel-r", "tab-r"),
      },
    });
    const project = (id: string, hostId: string) => ({
      id,
      name: id,
      path: "/test",
      hostId,
      defaultBranch: "main",
      selectedWorkspaceIndex: 0,
      workspaces: [
        { path: WS_A, branch: "a", isMain: true, name: null },
        { path: WS_B, branch: "b", isMain: false, name: null },
      ],
    });
    // The local project is selected, as it would be after a restart.
    useProjectStore.setState({
      selectedProjectIndex: 0,
      projects: [project("p-local", "local"), project("p-box", "box")],
    } as never);
    const locRemote: Location = {
      kind: "workspace",
      workspaceKey: remoteKey,
      panelId: "panel-r",
      tabId: "tab-r",
    };
    useNavigationHistoryStore.setState({
      entries: [locRemote, locB],
      index: 1,
      isNavigating: false,
    });

    navigateBack();
    await flushMicrotasks();

    expect(selectWorkspaceSpy).toHaveBeenCalledWith("p-box", 0);
    const app = useAppStore.getState();
    expect(app.activeWorkspacePath).toBe(WS_A);
    expect(app.activeWorkspaceHostId).toBe("box");
    expect(selectCurrentLocation(app)).toEqual(locRemote);
  });
});
