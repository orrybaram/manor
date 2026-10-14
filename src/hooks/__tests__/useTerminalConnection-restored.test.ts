/**
 * A pane restored from the layout at launch does not wake its sleeping host
 * on its first mount (ADR-230 D3); everything after that, and every pane the
 * user starts, wakes it as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../store/app-store";
import { resetFakeLayoutServer, seedLayout } from "../../store/__tests__/fake-layout-server";
import type { PtyCreateOptions, PtyCreateResult } from "../../electron.d";
import { workspaceKey } from "../../lib/workspace-key";

// The hook's React is only `useRef` and `useCallback`: called outside a
// render, each is what it holds.
vi.mock("react", () => ({
  useRef: <T>(current: T) => ({ current }),
  useCallback: <T>(fn: T) => fn,
}));

const { useTerminalConnection } = await import("../useTerminalConnection");

const WS_PATH = "/test/restored-panes";
const WS_KEY = workspaceKey("local", WS_PATH);

type Create = (
  paneId: string,
  cwd: string | null,
  cols: number,
  rows: number,
  opts?: PtyCreateOptions,
) => Promise<PtyCreateResult>;

let create: ReturnType<typeof vi.fn<Create>>;
const api = window.electronAPI as unknown as Record<string, unknown>;
let savedPty: unknown;

beforeEach(async () => {
  savedPty = api.pty;
  create = vi.fn<Create>(async () => ({
    ok: false,
    reason: "host-unavailable",
    hostId: "box",
    error: "box is asleep",
  }));
  api.pty = { create };
  resetFakeLayoutServer();
  useAppStore.setState({
    workspaceLayouts: {},
    mountedWorkspaces: {},
    layoutVersions: {},
    viewports: {},
    claims: {},
    restoredPaneIds: new Set(),
  });
  seedLayout(WS_PATH, {
    panelTree: { type: "leaf", panelId: "panel-1" },
    panels: {
      "panel-1": {
        id: "panel-1",
        tabs: [{ id: "tab-1", title: "Terminal", rootNode: { type: "leaf", paneId: "pane-restored" } }],
        pinnedTabIds: [],
      },
    },
  });
  await useAppStore.getState().loadPersistedLayout();
});

afterEach(() => {
  api.pty = savedPty;
});

const wakeOf = (call: number) => create.mock.calls[call][4]?.wake;

describe("a pane restored at launch (ADR-230 D3)", () => {
  it("is remembered from the layout read at launch", () => {
    expect([...useAppStore.getState().restoredPaneIds]).toEqual(["pane-restored"]);
  });

  it("declines to wake its host on its first create only, whatever that answered", async () => {
    const { create: open } = useTerminalConnection("pane-restored", WS_KEY);

    await open("/w", 80, 24);
    await open("/w", 80, 24);

    expect(wakeOf(0)).toBe(false);
    expect(wakeOf(1)).toBeUndefined();
    expect(useAppStore.getState().restoredPaneIds.has("pane-restored")).toBe(false);
  });

  it("declines on a remount that races its first create, as React's dev double-mount does", async () => {
    const { create: open } = useTerminalConnection("pane-restored", WS_KEY);

    await Promise.all([open("/w", 80, 24), open("/w", 80, 24)]);

    expect(wakeOf(0)).toBe(false);
    expect(wakeOf(1)).toBe(false);
  });

  it("wakes the host for a pane the user starts", async () => {
    const { create: open } = useTerminalConnection("pane-new", WS_KEY);

    await open("/w", 80, 24);

    expect(wakeOf(0)).toBeUndefined();
  });
});
