import type { PaneNode } from "./pane-tree";
import type { AgentState } from "../electron.d";

/**
 * Serialized form of a single tab handed across the process boundary when a tab
 * is detached into (or reattached from) a popup window (ADR-156).
 *
 * This is the one shared shape used by BOTH the renderer store (which produces
 * and consumes it) and the Electron IPC layer (which ferries it between
 * windows). It MUST be structured-clone-safe: plain data only — no class
 * instances, functions, or non-cloneable values — because it crosses IPC.
 */
export interface DetachedTabPayload {
  tab: {
    id: string;
    title: string;
    rootNode: PaneNode;
    focusedPaneId: string;
  };
  /** Every per-pane side-map entry for the tab's panes, keyed by paneId. */
  paneState: {
    cwd: Record<string, string | null>;
    title: Record<string, string | null>;
    contentType: Record<string, "terminal" | "browser" | "diff">;
    url: Record<string, string | null>;
    favicon: Record<string, string | null>;
    agentStatus: Record<string, AgentState | null>;
    audioPlaying: Record<string, boolean>;
    audioMuted: Record<string, boolean>;
  };
  /** Workspace the tab was detached from (informational; ephemeral windows). */
  sourceWorkspacePath: string;
}
