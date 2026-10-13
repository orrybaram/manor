/**
 * What this tab knows about the host it is connected to: the facts the
 * hello states, recorded once by `install-web.ts` and read by components.
 *
 * - `activeRoomId` — the relay room this page dials (the switcher marks it).
 * - `hostName` — the host names itself in its hello (ADR-225 D7); both the
 *   desktop and a host server do.
 * - `isHostServer` — the hello says `hostServer: true` only from a host
 *   server (ADR-226), which serves only a slice of the desktop's bridge
 *   (ADR-225 D5, D6): a phone paired with one can browse and drive existing agents but cannot create
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
export function recordHello(hello: {
  hostName: string | null;
  hostServer: boolean;
}): void {
  const hostName = hello.hostName?.trim() || null;
  const isHostServer = hello.hostServer;
  if (hostName === facts.hostName && isHostServer === facts.isHostServer) return;
  update({ hostName, isHostServer });
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
