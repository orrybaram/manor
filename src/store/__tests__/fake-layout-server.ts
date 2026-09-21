/**
 * The Manor server's layout store, in the test process (ADR-179 D1, ADR-182
 * D9).
 *
 * The renderer does not change layout; it sends a `LayoutCommand` and waits
 * for the broadcast that comes back. A store test that wants to assert what a
 * split *did* therefore needs something on the other end of
 * `window.electronAPI.layout` — and that something is the real
 * `LayoutStore`, built over an in-memory file and a PTY that kills nothing.
 * What is left here is wiring and a few thin recording shims (`sentCommands`
 * and friends) for the tests that assert the call itself.
 *
 * The real store answers the way the desktop does, a round trip later: a
 * command's broadcast lands after the `apply` promise's queue turns over, so a
 * test that sends one awaits {@link settled} before it looks.
 *
 * Two things the real store cannot do on its own, both for a test playing
 * "somebody else":
 *
 * - **`seedLayout`** hands it a workspace to start from, the way a
 *   `layout.json` on disk would (`LayoutStore.load`).
 * - **`broadcastLayout`** pushes an arbitrary layout at the renderer, at an
 *   arbitrary version, as another renderer's command would have. The store
 *   then holds that layout too, and every version it broadcasts afterwards
 *   is counted on from there (see `versionBase`), so a later command still
 *   reaches the renderer as the newer change.
 *
 * Installed from the vitest setup file, so `app-store.ts` finds it already on
 * `window.electronAPI` when it subscribes at import time.
 */

import type { ElectronAPI } from "../../electron";
import type { LayoutCommand } from "../../lib/layout/commands";
import { emptyViewport, type WorkspaceViewport } from "../../lib/layout/viewport";
import type {
  LayoutBroadcast,
  LayoutOrigin,
  LayoutPaneTitlePayload,
  PersistedPaneSession,
  PersistedViewportFile,
} from "../../lib/layout/protocol";
import type { LayoutClaim } from "../../lib/layout/visible-tabs";
import type { WorkspaceLayout } from "../../lib/layout/workspace-layout";
import {
  LayoutStore,
  type LayoutFile,
} from "../../../electron/layout/layout-store";
import type { PersistedLayout } from "../../../electron/terminal-host/layout-persistence";
import type { LocalBackend } from "../../../electron/backend/local-backend";

type LayoutApi = ElectronAPI["layout"];
type ViewportApi = ElectronAPI["viewport"];

/** What the fake calls the renderer under test — matching `rendererId`. */
export const FAKE_RENDERER_ID = "test-renderer";

/**
 * Who a broadcast came from when a test does not say: somebody other than
 * the renderer under test, so no selection hint lands on it.
 */
const ELSEWHERE: LayoutOrigin = { kind: "route", id: "fake-layout-server" };

/** The renderer under test, as the server names it on everything it sends. */
const RENDERER: LayoutOrigin = { kind: "window", id: FAKE_RENDERER_ID };

type Listener = (payload: LayoutBroadcast) => void;
type PaneTitleListener = (payload: LayoutPaneTitlePayload) => void;

const listeners = new Set<Listener>();
const paneTitleListeners = new Set<PaneTitleListener>();

/**
 * The version a workspace's server-side count starts from, per workspace.
 *
 * `broadcastLayout` stands in for a change the store did not make, at a
 * version it did not count to; it reseeds the store (which starts again at 0)
 * and moves this up, so what the renderer sees stays monotonic.
 */
const versionBase = new Map<string, number>();

/** What the store's next `load()` reads — one workspace being seeded. */
let fileToLoad: PersistedLayout | null = null;

/** The store's `layout.json`: read when seeded, and never written anywhere. */
const layoutFile: LayoutFile = {
  load: () => fileToLoad,
  save: () => {},
  removeWorkspace: () => {},
};

/** The renderer's claim, as main knows it from the window's launch argument. */
function claimOfRenderer(): { workspacePath: string; tabId: string } | null {
  const api = (window as unknown as { electronAPI?: Partial<ElectronAPI> })
    .electronAPI;
  return api?.claim ?? null;
}

function makeServer(): LayoutStore {
  return new LayoutStore(
    layoutFile,
    (payload) => {
      const seen = { ...payload, version: external(payload.workspacePath, payload.version) };
      for (const listener of listeners) listener(seen);
    },
    { pty: { kill: async () => {} } } as unknown as Pick<LocalBackend, "pty">,
    {
      isPrimary: (id) => id === FAKE_RENDERER_ID && claimOfRenderer() === null,
      claimOf: (id) => (id === FAKE_RENDERER_ID ? claimOfRenderer() : null),
    },
    (paneId, title) => {
      for (const listener of paneTitleListeners) listener({ paneId, title });
    },
  );
}

let server = makeServer();

/** The real store behind the fake API, for a test that asks it directly. */
export function layoutServer(): LayoutStore {
  return server;
}

function external(workspacePath: string, version: number): number {
  return version + (versionBase.get(workspacePath) ?? 0);
}

/** The version the renderer was last told, for one workspace. */
function currentVersion(workspacePath: string): number {
  return external(workspacePath, server.get(workspacePath)?.version ?? 0);
}

/** Every call still crossing the wire, so {@link settled} can wait them out. */
const inFlight = new Set<Promise<unknown>>();

function track<T>(call: Promise<T>): Promise<T> {
  inFlight.add(call);
  void call.finally(() => inFlight.delete(call)).catch(() => {});
  return call;
}

/**
 * Run `fn` on the server a hop later, the way an IPC call lands: never
 * inside the store update that sent it.
 */
function hop<T>(fn: () => T): Promise<T> {
  return track(Promise.resolve().then(fn));
}

/**
 * Wait until every command sent so far has been applied and broadcast, and
 * the store has read the answers.
 */
export async function settled(): Promise<void> {
  while (inFlight.size > 0) await Promise.all([...inFlight]);
  // One more turn for the `.then` the store hangs off each answer.
  await Promise.resolve();
}

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

/**
 * Give the server a workspace's default viewport, for a renderer with none —
 * as a paired device's report would, which moves nothing but the default.
 */
export function seedDefaultViewport(
  workspacePath: string,
  viewport: WorkspaceViewport,
): void {
  server.reportViewport(
    workspacePath,
    { kind: "bridge", id: "fake-device" },
    viewport,
  );
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

/**
 * Give the server a workspace to start from — what `getAll` will answer —
 * the way a `layout.json` on disk does. The version the renderer knows the
 * workspace at does not move.
 */
export function seedLayout(
  workspacePath: string,
  layout: WorkspaceLayout,
): void {
  const version = currentVersion(workspacePath);
  fileToLoad = {
    version: 3,
    workspaces: [
      {
        workspacePath,
        panelTree: layout.panelTree,
        panels: Object.fromEntries(
          Object.entries(layout.panels).map(([panelId, panel]) => [
            panelId,
            {
              id: panel.id,
              tabs: panel.tabs.map((tab) => ({ ...tab, paneSessions: {} })),
              pinnedTabIds: panel.pinnedTabIds,
            },
          ]),
        ),
        defaultViewport: emptyViewport(),
      },
    ],
    lastActiveWorkspacePath: server.getLastActiveWorkspacePath(),
  };
  try {
    server.load();
  } finally {
    fileToLoad = null;
  }
  versionBase.set(workspacePath, version);
}

/**
 * Push a layout at the store as if another renderer had changed it.
 *
 * `restored` is what the real server sends when a reopen lands inside its
 * grace: the sessions of the panes that came back. A test that cares about it
 * passes it in, rather than closing and reopening a pane to get one.
 */
export function broadcastLayout(
  workspacePath: string,
  layout: WorkspaceLayout,
  version?: number,
  restored?: Record<string, PersistedPaneSession>,
  extra?: {
    origin?: LayoutOrigin;
    hint?: LayoutBroadcast["hint"];
    claims?: LayoutClaim[];
  },
): void {
  const held = currentVersion(workspacePath);
  const next = version ?? held + 1;
  seedLayout(workspacePath, layout);
  versionBase.set(workspacePath, Math.max(next, held));
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
 * Forget a workspace the way the server does when its worktree is removed
 * (ADR-182 D7): `LayoutStore.remove`, which broadcasts `removed`.
 */
export function removeWorkspace(workspacePath: string): void {
  server.remove(workspacePath);
  versionBase.delete(workspacePath);
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
  server.flush();
  server = makeServer();
  versionBase.clear();
  inFlight.clear();
  reportedViewports.length = 0;
  viewportFile = null;
  sentCommands.length = 0;
  sentPaneTitles.length = 0;
  queuedCommands.length = 0;
  serverCalls.length = 0;
}

/** The `viewport` namespace of `window.electronAPI`, served from memory. */
export function fakeViewportApi(): ViewportApi {
  return {
    load: async () => viewportFile,
    save: async (file: PersistedViewportFile) => {
      viewportFile = file;
    },
  };
}

/** The `layout` namespace of `window.electronAPI`, served by the real store. */
export function fakeLayoutApi(): LayoutApi {
  return {
    getAll: async () => {
      const all = server.getAll();
      for (const [workspacePath, entry] of Object.entries(all)) {
        all[workspacePath] = {
          ...entry,
          version: external(workspacePath, entry.version),
        };
      }
      return all;
    },
    getLastActive: async () => server.getLastActiveWorkspacePath(),
    apply: (workspacePath: string, command: LayoutCommand) => {
      sentCommands.push({ workspacePath, command });
      serverCalls.push("apply");
      return track(
        server
          .apply(workspacePath, command, RENDERER)
          .then((result) =>
            "error" in result
              ? result
              : { ...result, version: external(workspacePath, result.version) },
          ),
      );
    },
    setPendingCommand: async (paneId, text, kind = "shell") => {
      queuedCommands.push({ paneId, text, kind });
      serverCalls.push("pending");
      server.pendingCommands.set(paneId, text, kind);
    },
    reportViewport: (workspacePath, viewport) => {
      reportedViewports.push({
        workspacePath,
        rendererId: FAKE_RENDERER_ID,
        viewport,
      });
      return hop(() => server.reportViewport(workspacePath, RENDERER, viewport));
    },
    setPaneTitle: (paneId, title) => {
      sentPaneTitles.push({ paneId, title });
      return hop(() => {
        server.setPaneTitle(paneId, title);
      });
    },
    onChanged: (listener: Listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onPaneTitle: (listener: PaneTitleListener) => {
      paneTitleListeners.add(listener);
      return () => {
        paneTitleListeners.delete(listener);
      };
    },
  };
}
