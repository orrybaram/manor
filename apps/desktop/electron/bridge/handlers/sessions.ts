/**
 * The `sessions` namespace: every agent CLI's Sessions (`CONTEXT.md`),
 * shared by the desktop's table (`../server-methods.ts`) and the host
 * server's (`../../host-server/handlers.ts`).
 *
 * Electron-free: it reads only {@link SessionsDeps}. Each server scans its
 * own host's stores (`../../sessions/scanner.ts`); **on the desktop the
 * answer is merged** with every adopted remote host's, asked of that host's
 * server, each Session carrying its host's id.
 */

import type { HostRouting } from "../../server/host-routing";
import { createSessionScanner, type SessionScanner } from "../../sessions/scanner";
import type { SessionSummary } from "../../sessions/types";
import { LOCAL_ROUTE, method, type HandlerCtx } from "../method";

export interface SessionsDeps {
  /** This host's scanner; the process's own when absent. */
  sessionScanner?: SessionScanner;
  /** Adopted remote hosts' Sessions, on the desktop. */
  hostRouting?: Pick<HostRouting, "sessions">;
}

let processScanner: SessionScanner | null = null;

/** The scanner whose cache lives as long as the process does. */
function ownScanner(deps: SessionsDeps): SessionScanner {
  if (deps.sessionScanner) return deps.sessionScanner;
  processScanner ??= createSessionScanner();
  return processScanner;
}

/** This host's Sessions and, on the desktop, every adopted host's, newest first. */
export async function sessionsList(ctx: HandlerCtx<SessionsDeps>): Promise<SessionSummary[]> {
  const [own, remote] = await Promise.all([
    ownScanner(ctx.deps).list(),
    ctx.deps.hostRouting?.sessions() ?? Promise.resolve([]),
  ]);
  if (remote.length === 0) return own;
  return [...own, ...remote].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * The desktop's table. A merged read: answered here whatever host it
 * touches, and by the renderer's router from every server it holds.
 */
export const sessions = {
  list: method(sessionsList, { route: LOCAL_ROUTE }),
};
