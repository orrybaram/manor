import { describe, it, expect, beforeEach } from "vitest";
import {
  useAppStore,
  selectCurrentLocation,
  type AppState,
  type WorkspaceLayout,
  type Tab,
  type Panel,
} from "../store/app-store";
import {
  useNavigationHistoryStore,
  locationsEqual,
  type Location,
} from "../store/navigation-history-store";
import { navigateBack, navigateForward } from "./useNavigationHistory";

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
    focusedPaneId: paneId,
  };
  const panel: Panel = {
    id: panelId,
    tabs: [tab],
    selectedTabId: tabId,
    pinnedTabIds: [],
  };
  return {
    panelTree: { type: "leaf", panelId },
    panels: { [panelId]: panel },
    activePanelId: panelId,
  };
}

function seedStore(overrides?: Partial<AppState>) {
  useAppStore.setState({
    activeWorkspacePath: null,
    workspaceLayouts: {
      [WS_A]: makeLayout("panel-a", "tab-a"),
      [WS_B]: makeLayout("panel-b", "tab-b"),
    },
    paneCwd: {},
    paneTitle: {},
    paneAgentStatus: {},
    paneContentType: {},
    paneUrl: {},
    panePickedElement: {},
    paneFavicon: {},
    paneAudioPlaying: {},
    paneAudioMuted: {},
    closedPaneIds: new Set(),
    closedPaneStack: [],
    pendingStartupCommands: {},
    pendingPaneCommands: {},
    pendingCloseConfirmPaneId: null,
    pendingCloseConfirmTabId: null,
    webviewFocusedPaneId: null,
    ...overrides,
  });
}

const locA: Location = {
  kind: "workspace",
  workspacePath: WS_A,
  panelId: "panel-a",
  tabId: "tab-a",
};
const locB: Location = {
  kind: "workspace",
  workspacePath: WS_B,
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
      workspacePath: "/gone",
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
      workspacePath: "/gone",
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
});
