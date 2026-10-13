/**
 * Who owns a pane's winsize on a host server (ADR-218 D5).
 *
 * ADR-178 D5 said the "is a desktop attached?" check would move into the
 * daemon once a host had no Electron main to ask. This is that host: the
 * daemon reports `attachedClients` on its session info, and a device viewer
 * is a **follower** whenever any client other than this server is attached,
 * and the owner otherwise.
 *
 * **How many sockets this server holds.** One stream socket per daemon
 * connection, subscribed to a session once however many devices view it
 * (`TerminalHostClient`'s subscriptions are per session, not per viewer). So
 * this server accounts for exactly one of a session's `attachedClients` while
 * a device holds the pane (`isHeld` in `pty-attachments.ts` — the last
 * device's detach is what unsubscribes) and none before the first attach.
 * Two phones on one pane are therefore not "someone else" to each other here;
 * the registry's own most-recent-attach rule still orders them.
 *
 * **The answer lives in the registry.** Whether someone else holds the pane is
 * `setForeign` on `pty-attachments.ts`, so the desktop pty handlers this
 * server reuses — create, resize, claim — and the bridge server's ownership
 * push all read it from the one place they already read the winsize owner.
 *
 * **Unknown is a follower.** A daemon that predates the field omits it. The
 * safe default is never to resize a session someone else may be viewing.
 *
 * **Poll, not event.** A change has to reach a phone that is already
 * attached (the desktop connected, or let go). The daemon could emit an
 * attach/detach stream event, but that is a new event type an older server
 * would have to ignore and the new one could not get from an older daemon;
 * polling `listSessions` every couple of seconds works against every daemon,
 * costs one cheap RPC, and runs only while a device holds a pane.
 */

import { isHeld, setForeign } from "../pty-attachments";
import type { SessionInfo } from "../terminal-host/types";

/** Poll cadence while any device holds a pane. */
export const WINSIZE_POLL_MS = 2_000;

/**
 * Whether a client other than this server is attached, given the daemon's
 * count and how many of those sockets are this server's own. A missing count
 * is unknown, which counts as someone else.
 */
export function hasOtherClients(
  attachedClients: number | undefined,
  ownSockets: number,
): boolean {
  if (attachedClients === undefined) return true;
  return attachedClients - ownSockets > 0;
}

/** Hold or free `paneId` in the registry from the daemon's attach count. */
function applyCount(paneId: string, attachedClients: number | undefined): void {
  const ownSockets = isHeld(paneId) ? 1 : 0;
  setForeign(paneId, hasOtherClients(attachedClients, ownSockets));
}

export interface HostWinsize {
  /**
   * A device is about to hold `paneId`: record what the daemon said about it
   * in the registry, and keep watching it.
   */
  watch(paneId: string, attachedClients: number | undefined): void;
  dispose(): void;
}

export interface HostWinsizeOptions {
  listSessions(): Promise<readonly SessionInfo[]>;
  intervalMs?: number;
}

export function createHostWinsize(opts: HostWinsizeOptions): HostWinsize {
  const watched = new Set<string>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let polling = false;

  function unwatch(paneId: string): void {
    watched.delete(paneId);
    setForeign(paneId, false);
  }

  async function tick(): Promise<void> {
    if (polling) return;
    polling = true;
    try {
      const sessions = new Map(
        (await opts.listSessions()).map((s) => [s.sessionId, s]),
      );
      for (const paneId of [...watched]) {
        const session = sessions.get(paneId);
        // Nobody holds it any more, or the session is gone: stop watching.
        if (!isHeld(paneId) || !session?.alive) {
          unwatch(paneId);
          continue;
        }
        applyCount(paneId, session.attachedClients);
      }
    } catch {
      // The daemon is unreachable: keep the last answer, look again.
    } finally {
      polling = false;
      if (watched.size === 0) stop();
    }
  }

  function stop(): void {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return {
    watch(paneId, attachedClients) {
      watched.add(paneId);
      applyCount(paneId, attachedClients);
      if (timer) return;
      timer = setInterval(() => void tick(), opts.intervalMs ?? WINSIZE_POLL_MS);
      timer.unref?.();
    },
    dispose() {
      stop();
      for (const paneId of [...watched]) unwatch(paneId);
    },
  };
}
