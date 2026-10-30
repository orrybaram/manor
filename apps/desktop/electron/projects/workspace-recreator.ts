/**
 * What a workspace move carries beyond the worktree: the
 * `WorkspaceRecreator` `workspace-host-move.ts` runs once the target
 * workspace exists, before the source is removed.
 *
 * **restore**: the source's layout, rebuilt in the target with fresh ids
 * (`layoutReplay`, `src/lib/layout/layout-replay.ts`). Terminals start
 * fresh, each with a queued `cd` to its old cwd under the new root.
 *
 * Each host's layout is read and changed where it lives
 * (`createWorkspaceRecreator`): in this desktop's `LayoutStore` for this
 * machine and for a remote host not yet adopted (keyed `<hostId>:<path>`),
 * and through the host's server (`HostProxy`) for an adopted one, as a
 * renderer's `layout.*` calls are routed there.
 */

import { LOCAL_HOST_ID } from "../backend/types";
import type { HostProxy } from "../backend/host-proxy";
import type { LayoutStore, LayoutOrigin } from "../layout/layout-store";
import type { PendingCommandKind, PendingCommandOptions } from "../layout/pending-commands";
import type { HostRouting } from "../server/host-routing";
import { shellQuote } from "../terminal-host/ssh-config";
import type { RecreateContext, RecreateStep, WorkspaceRecreator } from "./workspace-host-move";
import type { LayoutCommand } from "../../src/lib/layout/commands";
import { bindPanelId, layoutReplay, TARGET_FIRST_PANEL } from "../../src/lib/layout/layout-replay";
import type { LayoutApplyResult, LayoutEntry } from "../../src/lib/layout/protocol";
import { findPanelWithTab } from "../../src/lib/layout/workspace-layout";
import type { WorkspaceKey } from "../../src/lib/workspace-key";

/** One host's layout, wherever its store is. */
export interface HostLayout {
  /** The workspace's entry; null before it has one. */
  read(key: WorkspaceKey): Promise<LayoutEntry | null>;
  apply(key: WorkspaceKey, command: LayoutCommand): Promise<LayoutApplyResult>;
  /** Queue a pane's first line, before the apply that adds the pane. */
  queue(
    paneId: string,
    text: string,
    kind: PendingCommandKind,
    opts?: PendingCommandOptions,
  ): Promise<void>;
}

/** What a recreator needs of the server, injected so tests fake each host. */
export interface WorkspaceRecreatorDeps {
  layout(hostId: string): HostLayout;
}

/** The origin a move's layout commands carry. */
const MOVE_ORIGIN: LayoutOrigin = { kind: "route", id: "workspace-move" };

function hasTabs(entry: LayoutEntry | null): entry is LayoutEntry {
  return !!entry && Object.values(entry.layout.panels).some((p) => p.tabs.length > 0);
}

/** Send `commands` to `key` in order, binding the target's first panel once it exists. */
async function applyAll(
  layout: HostLayout,
  key: WorkspaceKey,
  commands: readonly LayoutCommand[],
  firstPanelKnown: boolean,
): Promise<void> {
  let firstPanel: string | null = null;
  for (const [i, raw] of commands.entries()) {
    const command: LayoutCommand = firstPanel
      ? bindPanelId(raw, TARGET_FIRST_PANEL, firstPanel)
      : raw;
    const result = await layout.apply(key, command);
    if ("error" in result) throw new Error(`Could not restore the layout: ${result.error}`);
    if (i === 0 && !firstPanelKnown && command.type === "new-tab") {
      // The server made the workspace's first panel for this tab: the rest
      // of the commands name it.
      const entry: LayoutEntry | null = await layout.read(key);
      const found: { panel: { id: string } } | null = entry
        ? findPanelWithTab(entry.layout, command.tab.id)
        : null;
      if (!found) throw new Error("Could not restore the layout: its first tab did not land");
      firstPanel = found.panel.id;
    }
  }
}

/** The recreator over `deps` (see the module header). */
export function workspaceRecreator(deps: WorkspaceRecreatorDeps): WorkspaceRecreator {
  return {
    async plan(source) {
      const entry = await deps.layout(source.hostId).read(source.key);
      const steps: RecreateStep[] = [];
      if (hasTabs(entry)) steps.push({ id: "restore" });
      return steps;
    },

    async run(move: RecreateContext, begin) {
      begin(0);
      const sourceEntry = await deps.layout(move.sourceHostId).read(move.sourceKey);
      if (!hasTabs(sourceEntry)) return;
      const target = deps.layout(move.targetHostId);
      const targetEntry = await target.read(move.targetKey);
      const replay = layoutReplay({
        source: sourceEntry.layout,
        paneSessions: sourceEntry.paneSessions,
        sourceRoot: move.sourcePath,
        targetRoot: move.targetPath,
        target: targetEntry,
      });
      // A shell line waits for whoever mounts the pane, so it goes first.
      for (const [paneId, cwd] of Object.entries(replay.cwds)) {
        await target.queue(paneId, `cd ${shellQuote(cwd)}`, "shell");
      }
      await applyAll(target, move.targetKey, replay.commands, targetEntry !== null);
    },
  };
}

/**
 * A host's layout as the desktop's server reaches it: its server's, through
 * the proxy, for an adopted host; else this desktop's `LayoutStore`.
 */
function hostLayout(
  server: {
    layoutStore: Pick<LayoutStore, "whenLoaded" | "get" | "apply" | "pendingCommands">;
    hostRouting?: Pick<HostRouting, "proxy">;
  },
  hostId: string,
): HostLayout {
  const proxy: HostProxy | null =
    hostId === LOCAL_HOST_ID ? null : (server.hostRouting?.proxy(hostId) ?? null);
  if (proxy) {
    return {
      async read(key) {
        // Asked now, not the proxy's cache: the workspace was just made.
        const all = (await proxy.invoke("layout", "getAll", [])) as Record<string, LayoutEntry>;
        return all[key] ?? null;
      },
      async apply(key, command) {
        return (await proxy.invoke("layout", "apply", [key, command, MOVE_ORIGIN])) as LayoutApplyResult;
      },
      async queue(paneId, text, kind, opts) {
        await proxy.invoke("layout", "setPendingCommand", [paneId, text, kind, opts ?? null]);
      },
    };
  }
  const store = server.layoutStore;
  return {
    async read(key) {
      await store.whenLoaded();
      return store.get(key);
    },
    apply: (key, command) => store.apply(key, command, MOVE_ORIGIN),
    async queue(paneId, text, kind, opts) {
      store.pendingCommands.set(paneId, text, kind, opts);
    },
  };
}

/** The recreator a move runs in the desktop's Manor server (`createWorkspaceHostMoveDeps`). */
export function createWorkspaceRecreator(server: {
  layoutStore: Pick<LayoutStore, "whenLoaded" | "get" | "apply" | "pendingCommands">;
  hostRouting?: Pick<HostRouting, "proxy">;
}): WorkspaceRecreator {
  return workspaceRecreator({ layout: (hostId) => hostLayout(server, hostId) });
}
