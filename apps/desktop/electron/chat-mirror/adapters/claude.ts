/** Claude Code's transcript format, read through `TranscriptParser`. */

import path from "node:path";
import { CHAT_SUBMIT } from "../chat-keys";
import { encodeChatMessage } from "../picker-keys";
import { TranscriptParser } from "../transcript";
import type { TranscriptAdapter } from "./types";

/** An agentId is a short token; anything else must not become a path. */
const TASK_REF = /^[A-Za-z0-9_-]+$/;

export const claudeAdapter: TranscriptAdapter = {
  // A subagent's transcript marks every line `isSidechain`.
  createParser: (opts) => new TranscriptParser({ sidechain: opts?.child === true }),
  /**
   * `<dir>/<sessionId>/subagents/agent-<agentId>.jsonl`, next to the parent's
   * `<dir>/<sessionId>.jsonl`. Computed rather than listed, so a
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
  /**
   * The text as one bracketed paste, then Enter on its own (in one write the
   * Enter can read as a new line). Unbracketed, Claude Code guesses at pastes
   * from how the bytes arrive, and a long prompt arrives in pieces where a pty
   * splits it (1022 bytes on macOS): each piece became its own paste, cut
   * mid-word. Brackets span the pieces. Short text still arrives as typed, and
   * a slash command still runs. `encodeChatMessage` drops Esc and other control
   * bytes, so the text can't close the paste early.
   */
  promptWrites: (text) => [`\x1b[200~${encodeChatMessage(text)}\x1b[201~`, CHAT_SUBMIT],
};
