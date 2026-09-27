/**
 * ReconnectSupervisor — the client's reconnect loop after the daemon drops
 * the connection unexpectedly: the backoff, "retry now", giving up, and
 * telling a `ConnectionListener` what happened.
 */

import { errorMessage } from "../lib/errors";

/**
 * How long to wait before reconnect attempt `attempt` (0-based) after the
 * connection drops unexpectedly, or `null` to give up — at which point every
 * wanted session is reported as exited.
 */
export type ReconnectPolicy = (attempt: number) => number | null;

/**
 * Observes unexpected connection loss and recovery. Never called for an
 * intentional `disconnect()`/`dispose()`.
 */
export interface ConnectionListener {
  /**
   * The connection dropped while connected. `sessionIds` are the sessions
   * the app is subscribed to; their output stops until a reconnect.
   */
  onLost?(info: { sessionIds: string[] }): void;
  /**
   * The reconnect loop got the connection back. `sessionIds` are the
   * sessions that survived and were re-subscribed — anything they printed
   * while disconnected was not delivered, so a consumer should resnapshot
   * them (`getSnapshot`).
   */
  onReconnected?(info: { sessionIds: string[]; attempts: number }): void;
  /**
   * The reconnect loop stopped on an error the reconnect policy classed as
   * permanent (see `setReconnectPolicy`). Nothing retries until something
   * calls `connect()` again; the sessions stay wanted, so a successful
   * connect re-subscribes them and reports `onReconnected`.
   */
  onFailed?(info: { error: unknown; sessionIds: string[]; attempts: number }): void;
  /**
   * The reconnect loop is about to wait `delayMs` before attempt `attempt`
   * (0-based). Attempt 0's delay is the one `onLost` precedes.
   */
  onRetryScheduled?(info: { attempt: number; delayMs: number }): void;
}

/** The connection the supervisor restores. */
export interface ReconnectTarget {
  /** Connect, re-subscribing wanted sessions; rejects if that fails. */
  connect(): Promise<void>;
  isConnected(): boolean;
  /**
   * Bumped by every intentional disconnect. A loop started under an older
   * value stops instead of reconnecting behind the caller's back.
   */
  generation(): number;
  /** Sessions the app is subscribed to. */
  wantedSessions(): string[];
  /** Out of attempts: report every wanted session as exited. */
  giveUp(): void;
}

/** Three quick attempts, then give up. */
const DEFAULT_DELAYS_MS = [250, 1_000, 2_000];

type ListenerCall = {
  [K in keyof ConnectionListener]-?: [
    K,
    Parameters<NonNullable<ConnectionListener[K]>>[0],
  ];
}[keyof ConnectionListener];

export class ReconnectSupervisor {
  /** True while the loop runs, so a second socket close during it does not
   *  start a competing loop. */
  private running = false;
  private policy: ReconnectPolicy = (attempt) => DEFAULT_DELAYS_MS[attempt] ?? null;
  /** Errors the loop must not retry (see `setPolicy`). */
  private isPermanentFailure: ((err: unknown) => boolean) | null = null;
  /**
   * The loop stopped on a permanent failure with sessions still wanted. The
   * next successful connect reports them via `onReconnected`.
   */
  private recoveryPending = false;
  private listener: ConnectionListener | null = null;
  /** Wakes the loop sleeping between attempts. */
  private wakeUp: (() => void) | null = null;

  constructor(private readonly target: ReconnectTarget) {}

  /** Whether the reconnect loop is running. */
  get reconnecting(): boolean {
    return this.running;
  }

  /** See `TerminalHostClient.setReconnectPolicy`. */
  setPolicy(
    policy: ReconnectPolicy,
    opts: { isPermanentFailure?: (err: unknown) => boolean } = {},
  ): void {
    this.policy = policy;
    this.isPermanentFailure = opts.isPermanentFailure ?? null;
  }

  setListener(listener: ConnectionListener | null): void {
    this.listener = listener;
  }

  /**
   * The connection dropped while connected: report it and start the loop.
   * Mid-loop (the connection died while being re-established) the loss was
   * already reported, and the running loop carries on retrying.
   */
  connectionLost(): void {
    if (!this.running) {
      this.notify("onLost", { sessionIds: this.target.wantedSessions() });
    }
    void this.run();
  }

  /**
   * A `connect()` outside the loop succeeded. If the loop had stopped on a
   * permanent failure, this is the recovery it left for someone to report.
   */
  connectedOutsideLoop(): void {
    if (!this.recoveryPending || this.running) return;
    this.recoveryPending = false;
    this.notify("onReconnected", {
      sessionIds: this.target.wantedSessions(),
      attempts: 1,
    });
  }

  /** An intentional disconnect: stop waiting, and forget any pending recovery. */
  cancel(): void {
    this.wakeUp?.();
    this.recoveryPending = false;
  }

  /**
   * Cut the loop's current wait short and attempt now ("Retry now").
   * Returns false when the loop is not waiting — not reconnecting, or
   * mid-attempt already.
   */
  retryNow(): boolean {
    if (!this.running || !this.wakeUp) return false;
    this.wakeUp();
    return true;
  }

  /**
   * Get a daemon back — the target's `connect()` spawns one if the old one
   * is gone and reconciles sessions. If that keeps failing, the sessions are
   * unreachable for good as far as the client can tell, so the target
   * reports every wanted one as exited rather than leave the renderer
   * waiting on output that will never come.
   */
  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const { target } = this;
    const generation = target.generation();
    try {
      for (let attempt = 0; ; attempt++) {
        const delay = this.policy(attempt);
        if (delay === null) break;
        this.notify("onRetryScheduled", { attempt, delayMs: delay });
        await this.sleep(delay);
        // disconnect() was called while we slept: the caller is done with us.
        if (generation !== target.generation()) return;
        try {
          await target.connect();
          // disconnect() landed after connect() finished. It already tore
          // down what connect() opened.
          if (generation !== target.generation()) return;
          // The connection dropped again while re-subscribing. connect()
          // swallows that (the session list is best-effort), and the loss
          // handler deferred to this loop — so this loop must go round again,
          // or nothing ever re-subscribes those sessions.
          if (!target.isConnected()) {
            throw new Error("connection lost while re-subscribing sessions");
          }
          console.warn(
            `[terminal-host] reconnected to daemon after unexpected disconnect (attempt ${attempt + 1})`,
          );
          this.recoveryPending = false;
          this.notify("onReconnected", {
            sessionIds: target.wantedSessions(),
            attempts: attempt + 1,
          });
          return;
        } catch (err) {
          if (generation !== target.generation()) return;
          if (this.isPermanentFailure?.(err)) {
            console.error(
              `[terminal-host] reconnect attempt ${attempt + 1} failed permanently; not retrying: ${errorMessage(err)}`,
            );
            const sessionIds = target.wantedSessions();
            this.recoveryPending = sessionIds.length > 0;
            this.notify("onFailed", { error: err, sessionIds, attempts: attempt + 1 });
            return;
          }
          console.warn(
            `[terminal-host] reconnect attempt ${attempt + 1} failed: ${errorMessage(err)}`,
          );
        }
      }
      console.error(
        `[terminal-host] giving up on the daemon; reporting ${target.wantedSessions().length} session(s) as exited`,
      );
      target.giveUp();
    } finally {
      this.running = false;
    }
  }

  /** Wait `ms`, or less if woken meanwhile. */
  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer: { id?: ReturnType<typeof setTimeout> } = {};
      const done = (): void => {
        clearTimeout(timer.id);
        if (this.wakeUp === done) this.wakeUp = null;
        resolve();
      };
      timer.id = setTimeout(done, ms);
      this.wakeUp = done;
    });
  }

  /** Call a listener hook without letting it throw into us. */
  private notify(...[hook, info]: ListenerCall): void {
    const listener = this.listener;
    if (!listener) return;
    try {
      (listener[hook] as ((arg: typeof info) => void) | undefined)?.call(listener, info);
    } catch (err) {
      console.error(`[terminal-host] connection listener ${hook} threw:`, err);
    }
  }
}
