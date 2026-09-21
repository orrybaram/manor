/**
 * The Manor server's layout store, in the test process (ADR-179 D1).
 *
 * The renderer no longer changes layout; it sends a `LayoutCommand` and waits
 * for the broadcast that comes back. A store test that wants to assert what a
 * split *did* therefore needs something on the other end of
 * `window.electronAPI.layout` — this is that something, and it runs the real
 * reducer, so the behavioural tests keep testing behaviour rather than a
 * recorded list of commands. `commands` is there for the tests that do want
 * to assert the command itself.
 *
 * Two deliberate differences from `electron/layout/layout-store.ts`:
 *
 * - **It broadcasts synchronously**, inside `apply`, before the promise it
 *   returns resolves. The desktop's round trip is one IPC hop; reproducing it
 *   here would make every assertion in every store test await something, for
 *   no coverage.
 * - **A test seeds it** (`seedLayout`, which the `setupStore` helpers call
 *   next to `useAppStore.setState`). Nothing here reads the store: this is
 *   the other side of the wire, and it has to be able to disagree.
 *
 * Installed from the vitest setup file, so `app-store.ts` finds it already on
 * `window.electronAPI` when it subscribes at import time.
 */

import {
  applyLayoutCommand,
  type ClosedPane,
  type LayoutCommand,
} from "../../lib/layout/commands";
import { allPaneIds } from "../../lib/layout/pane-tree";
import {
  createSinglePanelLayout,
  type WorkspaceLayout,
} from "../../lib/layout/workspace-layout";
import {
  emptyViewport,
  reconcileViewport,
  type LayoutHint,
  type WorkspaceViewport,
} from "../../lib/layout/viewport";
import type {
  LayoutBroadcast,
  LayoutOrigin,
  LayoutPaneTitlePayload,
  PersistedPaneSession,
  PersistedViewportFile,
} from "../../lib/layout/protocol";
import type { LayoutClaim } from "../../lib/layout/visible-tabs";

/** What the fake calls the renderer under test — matching `rendererId`. */
export const FAKE_RENDERER_ID = "test-renderer";

/**
 * Who a broadcast came from when a test does not say: somebody other than
 * the renderer under test, so no selection hint lands on it.
 */
const ELSEWHERE: LayoutOrigin = { kind: "route", id: "fake-layout-server" };

type Listener = (payload: LayoutBroadcast) => void;
type PaneTitleListener = (payload: LayoutPaneTitlePayload) => void;

const listeners = new Set<Listener>();
const paneTitleListeners = new Set<PaneTitleListener>();
const layouts = new Map<string, WorkspaceLayout>();
const versions = new Map<string, number>();
const closedStacks = new Map<string, ClosedPane[]>();
const defaultViewports = new Map<string, WorkspaceViewport>();

/** Every viewport report the store has made, newest last. */
export const reportedViewports: Array<{
  workspacePath: string;
  rendererId: string;
  viewport: WorkspaceViewport;
}> = [];

/** The renderer's own viewport file, as `viewport.load()` will answer it. */
let viewportFile: PersistedViewportFile | null = null;

/** What `viewport.save()` was last handed. */
export function savedViewportFile(): PersistedViewportFile | null {
  return viewportFile;
}

/** Seed the renderer's viewport file — a relaunch with a remembered tab. */
export function seedViewportFile(file: PersistedViewportFile | null): void {
  viewportFile = file;
}

/** Give the server a workspace's default viewport, for a renderer with none. */
export function seedDefaultViewport(
  workspacePath: string,
  viewport: WorkspaceViewport,
): void {
  defaultViewports.set(workspacePath, viewport);
}

/** Every command the store has sent since the last reset, newest last. */
export const sentCommands: Array<{
  workspacePath: string;
  command: LayoutCommand;
}> = [];

/** Every `layout.setPaneTitle` call the store has made, newest last. */
export const sentPaneTitles: Array<{
  paneId: string;
  title: string | null;
}> = [];

/** Every pending pane command the store has queued, newest last. */
export const queuedCommands: Array<{
  paneId: string;
  text: string;
  kind: string;
}> = [];

/**
 * Everything the store sent, in the order it sent it — `"pending"` for a
 * queued pane command, `"apply"` for a layout command.
 *
 * Exists for one assertion: a pending command must be queued *before* the
 * command that creates its pane, or a renderer can mount the pane and reach
 * `pty.create` with nothing waiting (ADR-179 ticket 11).
 */
export const serverCalls: Array<"pending" | "apply"> = [];

function paneIdsOf(layout: WorkspaceLayout): string[] {
  return Object.values(layout.panels).flatMap((panel) =>
    panel.tabs.flatMap((tab) => allPaneIds(tab.rootNode)),
  );
}

/** Give the server a workspace to start from — what `getAll` will answer. */
export function seedLayout(
  workspacePath: string,
  layout: WorkspaceLayout,
): void {
  layouts.set(workspacePath, layout);
}

/**
 * Push a layout at the store as if another renderer had changed it.
 *
 * `restored` is what the real server sends when a reopen lands inside its
 * grace: the sessions of the panes that came back. Nothing here can produce
 * one on its own — this fake keeps no `paneSessions` — so a test that cares
 * about it passes it in.
 */
export function broadcastLayout(
  workspacePath: string,
  layout: WorkspaceLayout,
  version?: number,
  restored?: Record<string, PersistedPaneSession>,
  extra?: {
    origin?: LayoutOrigin;
    hint?: LayoutHint;
    claims?: LayoutClaim[];
  },
): void {
  const next = version ?? (versions.get(workspacePath) ?? 0) + 1;
  versions.set(workspacePath, Math.max(next, versions.get(workspacePath) ?? 0));
  layouts.set(workspacePath, layout);
  for (const listener of listeners) {
    listener({
      workspacePath,
      version: next,
      layout,
      claims: extra?.claims ?? [],
      origin: extra?.origin ?? ELSEWHERE,
      ...(extra?.hint && { hint: extra.hint }),
      ...(restored && { restored }),
    });
  }
}

/**
 * Forget every `layout.changed` subscriber.
 *
 * For the one test file that imports a *second* `app-store` (a detached
 * window reads its claim at import time, so it needs a fresh module): without
 * this the module it replaced stays subscribed and answers broadcasts meant
 * for its successor.
 */
export function clearLayoutListeners(): void {
  listeners.clear();
  paneTitleListeners.clear();
}

export function resetFakeLayoutServer(): void {
  layouts.clear();
  versions.clear();
  closedStacks.clear();
  defaultViewports.clear();
  reportedViewports.length = 0;
  viewportFile = null;
  sentCommands.length = 0;
  sentPaneTitles.length = 0;
  queuedCommands.length = 0;
  serverCalls.length = 0;
}

/** The `viewport` namespace of `window.electronAPI`, served from memory. */
export function fakeViewportApi(): Record<string, unknown> {
  return {
    load: async () => viewportFile,
    save: async (file: PersistedViewportFile) => {
      viewportFile = file;
    },
  };
}

/** The `layout` namespace of `window.electronAPI`, served from memory. */
export function fakeLayoutApi(): Record<string, unknown> {
  return {
    getAll: async () => {
      const all: Record<string, unknown> = {};
      for (const [workspacePath, layout] of layouts) {
        all[workspacePath] = {
          version: versions.get(workspacePath) ?? 0,
          layout,
          defaultViewport: reconcileViewport(
            layout,
            defaultViewports.get(workspacePath) ?? emptyViewport(),
          ),
          paneSessions: {},
        };
      }
      return all;
    },
    getLastActive: async () => null,
    apply: async (workspacePath: string, command: LayoutCommand) => {
      sentCommands.push({ workspacePath, command });
      serverCalls.push("apply");
      const version = versions.get(workspacePath) ?? 0;
      // A workspace the server has never heard of gets one, panel and all —
      // `LayoutStore.ensure` does the same, and it is how the first tab of a
      // brand-new workspace lands anywhere.
      const layout =
        layouts.get(workspacePath) ??
        createSinglePanelLayout(`panel-${sentCommands.length}`, [], []);

      const result = applyLayoutCommand(
        { layout, closedStack: closedStacks.get(workspacePath) ?? [] },
        command,
      );
      closedStacks.set(workspacePath, result.closedStack);
      const { hint } = result;
      if (result.layout === layout) {
        return { version, addedPaneIds: [], ...(hint && { hint }) };
      }

      // The command's selection hint rides back with the broadcast, tagged
      // with the renderer that sent it, exactly as the server does it.
      broadcastLayout(workspacePath, result.layout, version + 1, undefined, {
        origin: { kind: "window", id: FAKE_RENDERER_ID },
        ...(hint && { hint }),
      });
      const had = new Set(paneIdsOf(layout));
      const addedPaneIds = paneIdsOf(result.layout).filter((id) => !had.has(id));
      return { version: version + 1, addedPaneIds, ...(hint && { hint }) };
    },
    setPendingCommand: async (paneId: string, text: string, kind: string) => {
      queuedCommands.push({ paneId, text, kind });
      serverCalls.push("pending");
    },
    remove: async (workspacePath: string) => {
      layouts.delete(workspacePath);
      versions.delete(workspacePath);
      closedStacks.delete(workspacePath);
    },
    reportViewport: async (
      workspacePath: string,
      viewport: WorkspaceViewport,
    ) => {
      // The real host names the reporter from the connection; the only
      // connection here is the renderer under test.
      reportedViewports.push({
        workspacePath,
        rendererId: FAKE_RENDERER_ID,
        viewport,
      });
      defaultViewports.set(workspacePath, viewport);
    },
    setPaneTitle: async (paneId: string, title: string | null) => {
      sentPaneTitles.push({ paneId, title });
      for (const listener of paneTitleListeners) listener({ paneId, title });
    },
    onChanged: (listener: Listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onPaneTitle: (listener: PaneTitleListener) => {
      paneTitleListeners.add(listener);
      return () => paneTitleListeners.delete(listener);
    },
  };
}
