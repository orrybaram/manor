/**
 * A **Session** as a list row: one conversation in an agent CLI's own
 * store on a host, whether or not Manor launched it (`CONTEXT.md`).
 *
 * Shared by the main process, the host server and the renderer
 * (`src/electron.d.ts` re-exports it). Pure types: nothing here imports a
 * runtime module.
 */

import type { HostId } from "../backend/types";
import type { AgentKind } from "../terminal-host/types";

export interface SessionSummary {
  /**
   * `<kind>:<sessionId>`, the same on every host that reports it: the
   * renderer's merge keeps one record per id, so a host listed under two
   * host ids still shows each Session once.
   */
  id: string;
  /** The host whose store holds it: `local` on the server that read it, stamped on the way out. */
  hostId: HostId;
  kind: AgentKind;
  /** The CLI's own id — what its resume command takes, and an Agent's `agentSessionId`. */
  sessionId: string;
  /** The name the user gave it, else the agent's own title, else its first real prompt. */
  title: string;
  /** The first prompt the user typed, as written (trimmed, capped); "" when none was found. */
  firstPrompt: string;
  /** Where it ran, from its records; "" when its records name none. */
  cwd: string;
  gitBranch: string | null;
  /** ISO time of its first record. */
  createdAt: string;
  /** ISO time of its last activity: the transcript's mtime. */
  updatedAt: string;
  /** Null when not cheaply known (Claude needs a full read for it). */
  messageCount: number | null;
  /** The model of its latest answer, when one was seen. */
  model: string | null;
  /** Its transcript on its host. */
  path: string;
  /** The Session it was forked from, when its store says so. */
  parentSessionId: string | null;
}

/** Where a reader looks: the host's home and environment, so tests can point it at fixtures. */
export interface SessionEnv {
  home: string;
  env: Readonly<Record<string, string | undefined>>;
}

/**
 * One agent CLI's store. A reader keeps its own cache between calls, so a
 * rescan reads only what changed; `list` never writes to the store.
 */
export interface SessionReader {
  kind: AgentKind;
  list(env: SessionEnv): Promise<SessionSummary[]>;
}
