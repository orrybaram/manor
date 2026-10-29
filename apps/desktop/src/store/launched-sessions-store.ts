import { create } from "zustand";

/**
 * Panes Manor typed a session's resume command into, by `kind:sessionId`.
 * Until the pane reports its Agent (an agent kind with no hooks may never
 * do so), this is how the Agents modal knows the session is in that pane,
 * so Resume goes to it instead of opening a second tab on the same session.
 * A pane that has since closed simply no longer counts.
 */
interface LaunchedSessionsState {
  panes: Readonly<Record<string, string>>;
  remember: (identity: string, paneId: string) => void;
}

export const useLaunchedSessions = create<LaunchedSessionsState>((set) => ({
  panes: {},
  remember: (identity, paneId) => set((s) => ({ panes: { ...s.panes, [identity]: paneId } })),
}));
