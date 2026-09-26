/**
 * SessionSubscriptions — the sessions the app wants a stream subscription
 * for, and squaring them with the daemon's session table after a (re)connect
 * (ADR-169).
 *
 * Deliberately survives the connection: after the daemon goes away this is
 * the list of terminals the renderer still believes are alive, and
 * `reconcile` turns it into re-subscribes or synthetic `exit` events.
 */

import { errorMessage } from "../lib/errors";

/** What the subscriptions need from the client. */
export interface SubscriptionIo {
  /** Ids of every session the daemon has; rejects if it cannot be asked. */
  listAlive(): Promise<string[]>;
  /** Subscribe the stream socket to `sessionId` (fire-and-forget). */
  subscribe(sessionId: string): void;
  /** Tell the app `sessionId` is gone, on the channel a real exit uses. */
  reportExit(sessionId: string): void;
}

export class SessionSubscriptions {
  private readonly wanted = new Set<string>();

  constructor(private readonly io: SubscriptionIo) {}

  ids(): string[] {
    return [...this.wanted];
  }

  /** Want `sessionId`'s stream, and subscribe to it now. */
  want(sessionId: string): void {
    this.wanted.add(sessionId);
    this.io.subscribe(sessionId);
  }

  /** The app is done with `sessionId` (killed or detached it). */
  forget(sessionId: string): void {
    this.wanted.delete(sessionId);
  }

  /** The app walked away from every session (an intentional disconnect). */
  forgetAll(): void {
    this.wanted.clear();
  }

  /** The sessions are unreachable for good: report every one as exited. */
  loseAll(): void {
    this.lose(this.ids());
  }

  /**
   * After a (re)connect: re-subscribe to every wanted session the daemon
   * still has, and emit a synthetic `exit` for every one it does not.
   *
   * Before ADR-169 a lost daemon left the client silent — no reconnect, no
   * events — and the renderer kept showing terminals whose PTYs were gone.
   * The `exit` here is what turns that freeze into the same closed-pane state
   * a shell exit produces, which the renderer already knows how to handle.
   */
  async reconcile(): Promise<void> {
    if (this.wanted.size === 0) return;
    let alive: Set<string>;
    try {
      alive = new Set(await this.io.listAlive());
    } catch (err) {
      // The connection died again mid-reconcile. The wanted set is intact, so
      // the next successful connect will pick this up.
      console.warn(
        `[terminal-host] could not list sessions after reconnect: ${errorMessage(err)}`,
      );
      return;
    }
    for (const sessionId of this.wanted) {
      if (alive.has(sessionId)) this.io.subscribe(sessionId);
    }
    this.lose(this.ids().filter((id) => !alive.has(id)));
  }

  private lose(sessionIds: string[]): void {
    for (const sessionId of sessionIds) {
      this.wanted.delete(sessionId);
      // Deliver off the current stack so a throwing handler cannot unwind a
      // connect() or reconnect loop that is still in progress.
      queueMicrotask(() => this.io.reportExit(sessionId));
    }
  }
}
