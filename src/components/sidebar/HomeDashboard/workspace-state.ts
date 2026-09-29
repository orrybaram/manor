import type { WorkspaceTileState } from "../../../lib/home-dashboard-studio";

/** How a project tile's workspace block names its state (ADR-198 §1.8). */
export const WORKSPACE_STATE_LABEL: Record<WorkspaceTileState, string> = {
  "needs-you": "Needs you",
  running: "Agent running",
  "pr-ready": "PR ready",
  "pr-open": "PR open",
  idle: "Idle",
};

export const WORKSPACE_STATE_COLOR: Record<WorkspaceTileState, string> = {
  "needs-you": "var(--red)",
  running: "var(--green)",
  "pr-ready": "var(--green)",
  "pr-open": "var(--accent)",
  idle: "var(--text-dim)",
};
