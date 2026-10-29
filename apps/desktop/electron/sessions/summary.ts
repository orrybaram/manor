/**
 * What every reader's {@link SessionSummary} shares: its record id, and the
 * bare row a transcript too large to read still gets.
 */

import { LOCAL_HOST_ID } from "../backend/types";
import type { AgentKind } from "../terminal-host/types";
import type { SessionSummary } from "./types";

/**
 * A Session's record id, `<kind>:<sessionId>`. No host in it: session ids
 * are UUIDs (or as unique), so two hosts never share one, and one host
 * reported under two host ids is the same Session, which the renderer's
 * merge then keeps once.
 */
export function sessionRecordId(kind: AgentKind, sessionId: string): string {
  return `${kind}:${sessionId}`;
}

/**
 * The row for a transcript whose records couldn't be read whole (a line
 * past the window cap): listed by what its file says, rather than hidden.
 */
export function bareSummary(kind: AgentKind, sessionId: string, path: string, mtimeMs: number): SessionSummary {
  const updatedAt = new Date(mtimeMs).toISOString();
  return {
    id: sessionRecordId(kind, sessionId),
    hostId: LOCAL_HOST_ID,
    kind,
    sessionId,
    title: "",
    firstPrompt: "",
    cwd: "",
    gitBranch: null,
    createdAt: updatedAt,
    updatedAt,
    messageCount: null,
    model: null,
    path,
    parentSessionId: null,
  };
}
