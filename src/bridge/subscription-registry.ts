/**
 * Who in this process is listening to what (ADR-182 D5).
 *
 * One connection carries every event a renderer hears, so the listening is
 * fanned out locally: the host sees one `subscribe` per `ns.event` + key, and
 * this registry holds the callbacks behind it. The preload keeps one for the
 * desktop (fed by its single `bridge:event` listener), and the WebSocket
 * transport keeps one for a browser — the same class, so the two cannot drift
 * apart in how they count, deliver or replay.
 *
 * **A reference count, not a set.** The listeners for a key are an array, so
 * two subscriptions that happen to share a callback stay two: React
 * StrictMode mounts an effect twice, and a `Set` would merge the pair — the
 * second unmount would then take the live subscription down with it. One
 * occurrence in, one occurrence out; the host is told `subscribe` when a key
 * goes from no listeners to one and `unsubscribe` when it goes back.
 *
 * Imports only `electron/bridge/types.ts`, which imports nothing, because the
 * preload bundles this file and must not pull the renderer in behind it.
 */

import {
  ALL_KEYS,
  type SubscribeFrame,
  type UnsubscribeFrame,
} from "../../electron/bridge/types";

/** Delivered a frame's `args`, spread — the shape an `onX` callback has. */
export type Listener = (...args: unknown[]) => void;

/** An event, as far as delivering it goes. */
interface DeliveredEvent {
  ns: unknown;
  event: unknown;
  key?: unknown;
  args?: unknown;
}

interface Entry {
  ns: string;
  event: string;
  /** Key (a paneId, or `ALL_KEYS`) → its listeners, duplicates and all. */
  byKey: Map<string, Listener[]>;
}

/** The frame that asks the host for `ns.event` at `key`. */
function subscribeFrame(ns: string, event: string, key: string): SubscribeFrame {
  return key === ALL_KEYS
    ? { kind: "subscribe", ns, event }
    : { kind: "subscribe", ns, event, key };
}

export class SubscriptionRegistry {
  /** `ns.event` → its entry. */
  private readonly entries = new Map<string, Entry>();

  /**
   * @param tell Hands the host a subscription change. Called on the first
   *   listener for a key and after its last one leaves, never in between.
   * @param label Names the owner in the log line a throwing listener writes.
   */
  constructor(
    private readonly tell: (frame: SubscribeFrame | UnsubscribeFrame) => void,
    private readonly label = "bridge",
  ) {}

  /**
   * Hear `ns.event`, for one `key` or — when there is none — for every key.
   * Returns the release, which is idempotent: React calls a cleanup once, but
   * a caller that keeps the handle and calls it twice must not decrement
   * somebody else's count.
   */
  subscribe(
    ns: string,
    event: string,
    key: string | null | undefined,
    listener: Listener,
  ): () => void {
    const name = `${ns}.${event}`;
    const slot = key ?? ALL_KEYS;
    let entry = this.entries.get(name);
    if (!entry) {
      entry = { ns, event, byKey: new Map() };
      this.entries.set(name, entry);
    }
    let list = entry.byKey.get(slot);
    if (!list) {
      list = [];
      entry.byKey.set(slot, list);
    }
    list.push(listener);
    if (list.length === 1) {
      this.tell(subscribeFrame(ns, event, slot));
    }

    let live = true;
    return () => {
      if (!live) return;
      live = false;
      const owner = this.entries.get(name);
      const current = owner?.byKey.get(slot);
      if (!owner || !current) return;
      const at = current.indexOf(listener);
      if (at !== -1) current.splice(at, 1);
      if (current.length > 0) return;
      owner.byKey.delete(slot);
      if (owner.byKey.size === 0) this.entries.delete(name);
      this.tell({ ...subscribeFrame(ns, event, slot), kind: "unsubscribe" });
    };
  }

  /**
   * One event, to everyone listening for it.
   *
   * A keyless event is about the machine (`projects.changed`), so every
   * listener of that name wants it. A keyed one is about one pane, and goes to
   * that pane's listeners plus anyone who subscribed without naming one.
   */
  deliver(frame: DeliveredEvent): void {
    if (typeof frame.ns !== "string" || typeof frame.event !== "string") return;
    const entry = this.entries.get(`${frame.ns}.${frame.event}`);
    if (!entry) return;
    const args = Array.isArray(frame.args) ? (frame.args as unknown[]) : [];
    const lists =
      typeof frame.key === "string"
        ? [entry.byKey.get(frame.key), entry.byKey.get(ALL_KEYS)]
        : [...entry.byKey.values()];
    for (const list of lists) {
      if (!list) continue;
      for (const listener of [...list]) {
        try {
          listener(...args);
        } catch (err) {
          // One bad listener must not cost the others their event.
          console.error(
            `[${this.label}] ${frame.ns}.${frame.event} listener threw:`,
            err,
          );
        }
      }
    }
  }

  /**
   * A `subscribe` frame for every key with a listener: what a fresh
   * connection must be told to hear what this one heard.
   */
  keys(): SubscribeFrame[] {
    const frames: SubscribeFrame[] = [];
    for (const { ns, event, byKey } of this.entries.values()) {
      for (const slot of byKey.keys()) {
        frames.push(subscribeFrame(ns, event, slot));
      }
    }
    return frames;
  }
}
