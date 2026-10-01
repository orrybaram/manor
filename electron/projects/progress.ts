/**
 * Progress events `ProjectManager` sends its renderers (ADR-183 split these
 * out of `ProjectManager`).
 *
 * Through `renderer-broadcast.ts` (ADR-180 D5), so every renderer the bridge
 * serves — desktop windows and paired browsers alike — is reached the same
 * way, and this module never touches a `BrowserWindow`.
 */

import {
  publishRendererBroadcast,
  publishToRenderer,
} from "../renderer-broadcast";
import type { CloneProgress } from "./remote-clone";
import type { SetupStep, StepStatus } from "../../src/store/project-store";

/**
 * One step of creating a worktree, as a `projects.worktreeProgress` event.
 *
 * Addressed to the connection that asked for the worktree when there is one
 * (ADR-180 D5): this is a progress bar in one dialog, in one window, and a
 * second desktop window has no business being told about it. `origin` is
 * null for the callers that have no renderer behind them — the CLI, MCP, the
 * issue-batch path — and then it is a broadcast, which is what every window
 * used to get unconditionally.
 */
export function emitSetupProgress(
  origin: string | null,
  step: SetupStep,
  status: StepStatus,
  message?: string,
): void {
  publishToRenderer(origin, "projects", "worktreeProgress", {
    step,
    status,
    message,
  });
}

/** Clone progress on its own event, `projects.cloneProgress` (ADR-183 ticket 1). */
export const emitCloneProgress: CloneProgress = (status, message) => {
  publishRendererBroadcast("projects", "cloneProgress", { status, message });
};
