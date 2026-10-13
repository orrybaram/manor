/**
 * What this tab knows about the host it is connected to: the facts the
 * hello states, recorded once by `install-web.ts` and read by components.
 *
 * - `activeRoomId` — the relay room this page dials (the switcher marks it).
 * - `hostName` — a host server names itself in its hello (ADR-218 D7); the
 *   desktop never does.
 * - `isHostServer` — so a hello with a `hostName` is a host server's, which
 *   serves only a slice of the desktop's bridge (ADR-218 D5, D6): a phone
 *   paired with one can browse and drive existing agents but cannot create
 *   workspaces or launch new agents. Entry points read this and state the
 *   limit up front rather than learning it from a refused call.
 *
 * A page serves one host (switching reloads), so nothing here is ever reset.
 * The desktop never writes any of it: there every fact keeps its default.
 */

import { useSyncExternalStore } from "react";

export interface ConnectionFacts {
  activeRoomId: string | null;
  hostName: string | null;
  isHostServer: boolean;
}

const INITIAL: ConnectionFacts = {
  activeRoomId: null,
  hostName: null,
  isHostServer: false,
};

let facts: ConnectionFacts = INITIAL;
const listeners = new Set<() => void>();

function update(next: Partial<ConnectionFacts>): void {
  facts = { ...facts, ...next };
  for (const cb of [...listeners]) cb();
}

/** `install-web.ts` records the room this page dials. */
export function setActiveRoom(roomId: string | null): void {
  if (roomId === facts.activeRoomId) return;
  update({ activeRoomId: roomId });
}

/** `install-web.ts` records what each hello says about the host. */
export function recordHello(hello: { hostName: string | null }): void {
  const hostName = hello.hostName?.trim() || null;
  if (hostName === facts.hostName) return;
  update({ hostName, isHostServer: hostName !== null });
}

export function getConnection(): ConnectionFacts {
  return facts;
}

/** The room this page dials, for the switcher to mark. */
export function getActiveRoom(): string | null {
  return facts.activeRoomId;
}

export function isHostServer(): boolean {
  return facts.isHostServer;
}

export function subscribeConnection(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useConnection(): ConnectionFacts {
  return useSyncExternalStore(subscribeConnection, getConnection, () => INITIAL);
}

/**
 * What an entry point says in place of an action a host server does not do:
 * "Creating workspaces is not available on Studio yet".
 */
export function hostServerUnavailableCopy(
  action: string,
  hostName: string | null,
): string {
  return `${action} is not available on ${hostName ?? "this host"} yet`;
}

