/** Which agents the chat mirror can read, by kind. */

import type { AgentKind } from "../../terminal-host/types";
import { claudeAdapter } from "./claude";
import { piAdapter } from "./pi";
import type { TranscriptAdapter } from "./types";

/**
 * The adapter for an agent's transcript format, or null if it has none yet.
 * Answers for exactly the kinds in `CHAT_KINDS` (`src/lib/agent-chat.ts`),
 * the renderer's gate: add a kind to both.
 */
export function adapterFor(kind: AgentKind): TranscriptAdapter | null {
  switch (kind) {
    case "claude":
      return claudeAdapter;
    case "pi":
      return piAdapter;
    default:
      return null;
  }
}
