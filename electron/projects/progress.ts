/**
 * Progress events `ProjectManager` sends its renderers (ADR-183 split these
 * out of `ProjectManager`).
 *
 * Through a publish function the composer hands `ProjectManager` (ADR-227
 * D1), so every renderer the server serves — desktop windows and paired
 * browsers alike — is reached the same way, and this module neither touches a
 * `BrowserWindow` nor reaches for the desktop's global sinks.
 */

import type { PublishToRenderer } from "../renderer-broadcast";
import type { CloneProgress } from "./remote-clone";
import type { SetupStep, StepStatus } from "../../src/store/project-store";

export interface ProjectProgress {
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
  setup(
    origin: string | null,
    step: SetupStep,
    status: StepStatus,
    message?: string,
  ): void;
  /** Clone progress on its own event, `projects.cloneProgress` (ADR-183 ticket 1). */
  clone: CloneProgress;
}

export function createProjectProgress(
  publish: PublishToRenderer,
): ProjectProgress {
  return {
    setup: (origin, step, status, message) =>
      publish(origin, "projects", "worktreeProgress", {
        step,
        status,
        message,
      }),
    clone: (status, message) =>
      publish(null, "projects", "cloneProgress", { status, message }),
  };
}
