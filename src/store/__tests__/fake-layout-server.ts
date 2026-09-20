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
import {
  createSinglePanelLayout,
  type WorkspaceLayout,
} from "../../lib/layout/workspace-layout";

interface Broadcast {
  workspacePath: string;
  version: number;
  layout: WorkspaceLayout;
  claims: never[];
}

type Listener = (payload: Broadcast) => void;

const listeners = new Set<Listener>();
const layouts = new Map<string, WorkspaceLayout>();
const versions = new Map<string, number>();
const closedStacks = new Map<string, ClosedPane[]>();

/** Every command the store has sent since the last reset, newest last. */
export const sentCommands: Array<{
  workspacePath: string;
  command: LayoutCommand;
}> = [];

/** Give the server a workspace to start from — what `getAll` will answer. */
export function seedLayout(
  workspacePath: string,
  layout: WorkspaceLayout,
): void {
  layouts.set(workspacePath, layout);
}

/** Push a layout at the store as if another renderer had changed it. */
export function broadcastLayout(
  workspacePath: string,
  layout: WorkspaceLayout,
  version?: number,
): void {
  const next = version ?? (versions.get(workspacePath) ?? 0) + 1;
  versions.set(workspacePath, Math.max(next, versions.get(workspacePath) ?? 0));
  layouts.set(workspacePath, layout);
  for (const listener of listeners) {
    listener({ workspacePath, version: next, layout, claims: [] });
  }
}

export function resetFakeLayoutServer(): void {
  layouts.clear();
  versions.clear();
  closedStacks.clear();
  sentCommands.length = 0;
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
          defaultViewport: {
            activePanelId: layout.activePanelId,
            selectedTabIds: {},
            focusedPaneIds: {},
          },
          paneSessions: {},
        };
      }
      return all;
    },
    getLastActive: async () => null,
    getRestoredSessions: async () => ({
      daemonSessions: [],
      persistedSessionIds: [],
    }),
    apply: async (workspacePath: string, command: LayoutCommand) => {
      sentCommands.push({ workspacePath, command });
      const version = versions.get(workspacePath) ?? 0;
      // A workspace the server has never heard of gets one, panel and all —
      // `LayoutStore.ensure` does the same, and it is how the first tab of a
      // brand-new workspace lands anywhere.
      const layout =
        layouts.get(workspacePath) ??
        createSinglePanelLayout(`panel-${sentCommands.length}`, [], "", []);

      const result = applyLayoutCommand(
        { layout, closedStack: closedStacks.get(workspacePath) ?? [] },
        command,
      );
      closedStacks.set(workspacePath, result.closedStack);
      if (result.layout === layout) return { version };

      broadcastLayout(workspacePath, result.layout, version + 1);
      return { version: version + 1 };
    },
    remove: async (workspacePath: string) => {
      layouts.delete(workspacePath);
      versions.delete(workspacePath);
      closedStacks.delete(workspacePath);
    },
    reportViewport: async () => undefined,
    onChanged: (listener: Listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
