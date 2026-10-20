/** Which agents the chat mirror can read, by kind. */

import type { AgentKind } from "../../terminal-host/types";
import { claudeAdapter } from "./claude";
import type { TranscriptAdapter } from "./types";

/** The adapter for an agent's transcript format, or null if it has none yet. */
export function adapterFor(kind: AgentKind): TranscriptAdapter | null {
  switch (kind) {
    case "claude":
      return claudeAdapter;
    default:
      return null;
  }
}
