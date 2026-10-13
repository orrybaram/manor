/** Claude Code's transcript format, read through `TranscriptParser`. */

import path from "node:path";
import { TranscriptParser } from "../transcript";
import type { TranscriptAdapter } from "./types";

/** An agentId is a short token; anything else must not become a path. */
const TASK_REF = /^[A-Za-z0-9_-]+$/;

export const claudeAdapter: TranscriptAdapter = {
  // A subagent's transcript marks every line `isSidechain` (ADR-224 D3).
  createParser: (opts) => new TranscriptParser({ sidechain: opts?.child === true }),
  /**
   * `<dir>/<sessionId>/subagents/agent-<agentId>.jsonl`, next to the parent's
   * `<dir>/<sessionId>.jsonl` (ADR-224 D3). Computed rather than listed, so a
   * remote host reads it the same way; posix, because remote hosts are.
   */
  childTranscriptPath: (parentPath, task) => {
    if (task.taskKind !== "agent" || !task.taskRef) return null;
    if (!TASK_REF.test(task.taskRef)) return null;
    return path.posix.join(
      path.posix.dirname(parentPath),
      path.posix.basename(parentPath, ".jsonl"),
      "subagents",
      `agent-${task.taskRef}.jsonl`,
    );
  },
};
