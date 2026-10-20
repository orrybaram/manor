/**
 * The desktop's idle stop: a recipe host with `idleStopMinutes`
 * is stopped once its server has said it is idle that long, while this
 * desktop is awake. With the lid closed it is the box hook's job, or the
 * provider's own `autoSleep`.
 *
 * One timer per host, armed when the host goes idle (or is found idle on
 * connect) and cancelled when it goes busy or away. When it fires, every
 * condition is checked again against a fresh status read, right before the
 * stop: still idle for long enough, no window has a pane of the host mounted,
 * the provider not busy and not already sleeping. A host that fails only the
 * "mounted" test is looked at again every `recheckMs`. A stop is never sent
 * while busy.
 */

import { errorMessage } from "../lib/errors";
import type { HostServerStatus } from "../host-server/relay";

/** How long a host kept awake by a mounted pane waits before it is looked at again. */
export const IDLE_STOP_RECHECK_MS = 60_000;

export interface HostIdleStopOptions {
  /** The recipe's `idleStopMinutes`; undefined for a host with no idle stop. */
  minutes(hostId: string): number | undefined;
  /** A fresh status read; null when the host's server cannot be reached. */
  status(
    hostId: string,
  ): Promise<Pick<HostServerStatus, "busy" | "idleForMs" | "desktopViewing" | "viewing"> | null>;
  /** What the provider was last told by `setBusy`. */
  providerBusy(hostId: string): boolean;
  isSleeping(hostId: string): boolean;
  stop(hostId: string): Promise<void>;
  now?: () => number;
  recheckMs?: number;
  log?: Pick<Console, "warn">;
}

export class HostIdleStop {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Bumped by everything that changes what a check in flight should do. */
  private readonly epochs = new Map<string, number>();
  private readonly now: () => number;
  private readonly recheckMs: number;
  private readonly log: Pick<Console, "warn">;

  constructor(private readonly opts: HostIdleStopOptions) {
    this.now = opts.now ?? Date.now;
    this.recheckMs = opts.recheckMs ?? IDLE_STOP_RECHECK_MS;
    this.log = opts.log ?? console;
  }

  /** The host has been idle since `idleSince` (epoch ms). */
  idle(hostId: string, idleSince: number): void {
    const minutes = this.opts.minutes(hostId);
    this.cancel(hostId);
    if (minutes === undefined) return;
    this.arm(hostId, idleSince + minutes * 60_000 - this.now());
  }

  /** The host is busy: nothing is to be stopped. */
  busy(hostId: string): void {
    this.cancel(hostId);
  }

  /** The host is away, asleep or gone. A later connect arms it again. */
  forget(hostId: string): void {
    this.cancel(hostId);
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private cancel(hostId: string): void {
    this.epochs.set(hostId, this.epoch(hostId) + 1);
    const timer = this.timers.get(hostId);
    if (timer) clearTimeout(timer);
    this.timers.delete(hostId);
  }

  private epoch(hostId: string): number {
    return this.epochs.get(hostId) ?? 0;
  }

  private arm(hostId: string, delayMs: number): void {
    this.cancel(hostId);
    const timer = setTimeout(() => {
      // Not ours any more once cancelled or re-armed.
      if (this.timers.get(hostId) !== timer) return;
      this.timers.delete(hostId);
      void this.check(hostId);
    }, Math.max(0, delayMs));
    timer.unref?.();
    this.timers.set(hostId, timer);
  }

  private async check(hostId: string): Promise<void> {
    const minutes = this.opts.minutes(hostId);
    if (minutes === undefined || this.opts.providerBusy(hostId) || this.opts.isSleeping(hostId)) {
      return;
    }
    const epoch = this.epoch(hostId);
    let status;
    try {
      status = await this.opts.status(hostId);
    } catch (err) {
      this.log.warn(`[host-idle-stop] ${hostId}: reading its status failed: ${errorMessage(err)}`);
      return;
    }
    // Cancelled or re-armed (a busy flip, a disconnect) while the read was out.
    if (this.epoch(hostId) !== epoch) return;
    // An older server cannot say; one that cannot be reached is away.
    if (!status || status.busy !== false || typeof status.idleForMs !== "number") return;
    const remaining = minutes * 60_000 - status.idleForMs;
    if (remaining > 0) {
      this.arm(hostId, remaining);
      return;
    }
    // An older host has no `viewing`: `desktopViewing` alone, as before.
    const { desktop, device, forwarded } = status.viewing ?? {};
    if (status.desktopViewing !== false || desktop || device || forwarded) {
      this.arm(hostId, this.recheckMs);
      return;
    }
    // The last look, after the last await.
    if (this.opts.providerBusy(hostId) || this.opts.isSleeping(hostId)) return;
    try {
      await this.opts.stop(hostId);
    } catch (err) {
      this.log.warn(`[host-idle-stop] ${hostId}: stopping failed: ${errorMessage(err)}`);
    }
  }
}
