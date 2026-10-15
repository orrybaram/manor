/**
 * `layout.setPendingCommand` for panes no layout holds yet (ADR-228 D1).
 *
 * The renderer cannot tell which server such a pane will be on until the
 * layout command that adds it goes out, so the queued line waits for it and
 * goes to the same server first — what main's `HostRouting` does for a pane
 * it cannot place (`movePendingCommands`). If no such command comes within
 * `holdMs`, the line goes home, where main places it as before.
 */

import { stringsIn } from "../../electron/bridge/routes";

/**
 * How long a queued command for a pane no layout holds yet waits for the
 * layout command that adds the pane, before it goes home anyway.
 */
const HOLD_PENDING_MS = 5_000;

export interface HeldCommands<T> {
  /**
   * Hold `layout.setPendingCommand`'s `args` until a layout command names
   * its pane. Answered at once: the caller only needs it sent before that
   * command, and this keeps it so. Args with no pane id go home now.
   */
  hold(args: unknown[]): Promise<void>;
  /**
   * A call about to go to `target`: if it is `layout.apply`, the held
   * commands of the panes it names go there first.
   */
  releaseFor(ns: string, name: string, args: unknown[], target: T): void;
}

export interface HeldCommandsOptions<T> {
  /** Send `layout.setPendingCommand(...args)` to `target`. */
  send(target: T, args: unknown[]): unknown;
  /** Where a command no layout command claimed goes: the home server. */
  home(): T;
  holdMs?: number;
}

export function createHeldCommands<T>(options: HeldCommandsOptions<T>): HeldCommands<T> {
  const { send, home } = options;
  const holdMs = options.holdMs ?? HOLD_PENDING_MS;
  const held = new Map<string, { args: unknown[]; timer: ReturnType<typeof setTimeout> }>();

  /** Send `paneId`'s held command to `target`, ahead of whatever follows. */
  function release(paneId: string, target: T): void {
    const entry = held.get(paneId);
    if (!entry) return;
    held.delete(paneId);
    clearTimeout(entry.timer);
    // The line as it was queued: main moves it to a host unchanged, too.
    void Promise.resolve(send(target, entry.args)).catch((err: unknown) => {
      console.error(`[bridge-router] pending command for ${paneId} failed:`, err);
    });
  }

  return {
    hold(args) {
      const paneId = args[0];
      if (typeof paneId !== "string") {
        return Promise.resolve(send(home(), args)).then(() => {});
      }
      release(paneId, home());
      const timer = setTimeout(() => release(paneId, home()), holdMs);
      held.set(paneId, { args, timer });
      return Promise.resolve();
    },

    releaseFor(ns, name, args, target) {
      if (held.size === 0 || ns !== "layout" || name !== "apply") return;
      for (const paneId of stringsIn(args[1])) release(paneId, target);
    },
  };
}
