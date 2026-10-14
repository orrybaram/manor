/**
 * What this tab knows about its **home** server: the facts its hello states,
 * as components read them.
 *
 * - `activeRoomId` — the relay room the home server is dialled through (the
 *   switcher marks it).
 * - `hostName` — the server names itself in its hello (ADR-225 D7); both the
 *   desktop and a host server do.
 * - `isHostServer` — the hello says `hostServer: true` only from a host
 *   server (ADR-226), which serves only a slice of the desktop's bridge
 *   (ADR-225 D5, D6): a phone paired with one can browse and drive existing agents but cannot create
 *   workspaces or launch new agents. Entry points read this and state the
 *   limit up front rather than learning it from a refused call.
 *
 * The facts live on the home entry of the server set (`./server-set.ts`,
 * ADR-228 D1); this module is a selector over it, kept so its callers did not
 * have to change. The desktop never writes any of it: there every fact keeps
 * its default.
 *
 * TODO(ADR-228): a caller that means "the host this workspace is on", not
 * "the page's home server" — `isHostServer()` gating a new-workspace entry
 * point, say — should read that host's entry in `useServers()` instead, and
 * this module go once none is left.
 */

import { useSyncExternalStore } from "react";

import { servers, subscribeSelected } from "./server-set";

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

/** The home entry's facts as `ConnectionFacts`, the same object while unchanged. */
export function getConnection(): ConnectionFacts {
  const home = servers.facts(servers.homeId);
  const next = {
    activeRoomId: home.roomId,
    hostName: home.hello.name,
    isHostServer: home.hello.hostServer,
  };
  if (
    next.activeRoomId !== facts.activeRoomId ||
    next.hostName !== facts.hostName ||
    next.isHostServer !== facts.isHostServer
  ) {
    facts = next;
  }
  return facts;
}

/** `install-web.ts` records the room this page dials. */
export function setActiveRoom(roomId: string | null): void {
  servers.setRoom(servers.homeId, roomId);
}

/** What a hello says about the home server. */
export function recordHello(hello: {
  hostName: string | null;
  hostServer: boolean;
}): void {
  servers.recordHello(servers.homeId, hello);
}

/** The room this page dials, for the switcher to mark. */
export function getActiveRoom(): string | null {
  return getConnection().activeRoomId;
}

export function isHostServer(): boolean {
  return getConnection().isHostServer;
}

export function subscribeConnection(cb: () => void): () => void {
  return subscribeSelected(servers, getConnection, cb);
}

/** The home server's facts. See the TODO above before reaching for it. */
export function useConnection(): ConnectionFacts {
  return useSyncExternalStore(subscribeConnection, getConnection, () => INITIAL);
}
