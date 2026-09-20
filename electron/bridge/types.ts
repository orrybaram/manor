/**
 * The bridge protocol, in one file (ADR-180 D1).
 *
 * The frames on the wire and the one thing dispatch knows about a caller.
 * `BridgeServer` speaks these; a transport carries them. Which is why this
 * file imports nothing: a `WebSocket`, an `ipcMain` channel and whatever
 * carries these next must all be describable in the same five shapes, and a
 * type that reached for `ws` here would have decided that question for them.
 *
 * What this is *not*: it is not the handler table (`handlers.ts` is), not the
 * dispatcher (`server.ts` is), and not a client. `src/web/ws-bridge.ts` holds
 * the browser's half and mirrors these shapes by hand — the two sides are
 * separate builds, and there is no shared module for them to agree through.
 *
 * A frame is one of five kinds. The client sends `invoke`, `subscribe` and
 * `unsubscribe`; the host answers `result` and pushes `event`. The hello
 * frame is deliberately absent: it belongs to the WebSocket transport, which
 * is the only one that has anything to authenticate (D2).
 */

/** Bumped when a frame's shape changes in a way a client must notice. */
export const BRIDGE_PROTOCOL_VERSION = 1;

/**
 * The `code` on a rejected result frame for anything the bridge does not do.
 * The client turns it into `BridgeUnavailableError`, which the renderer
 * renders as a stated empty state.
 */
export const UNAVAILABLE_CODE = "unavailable:web";

/**
 * A method that is in the table on purpose and refuses on purpose.
 *
 * Refusing beats silently dropping: a browser whose call is quietly discarded
 * has lost the user's work without being able to say so. No entry refuses
 * today — ADR-179 moved layout to the Manor server and `layout.save`, the
 * last one, went with it — but the shape stays, because the next method that
 * is deliberately unavailable should refuse rather than 404. A method that is
 * unavailable to *devices only* is a different thing and says so a different
 * way: `LOCAL_ONLY` in `handlers.ts` (ADR-180 D4).
 */
export class BridgeRefusal extends Error {
  readonly code = UNAVAILABLE_CODE;
  constructor(message: string) {
    super(message);
    this.name = "BridgeRefusal";
  }
}

/** A call: `ns.method(...args)`, answered with a `ResultFrame` carrying `id`. */
export interface InvokeFrame {
  kind: "invoke";
  /**
   * The client's correlation id, echoed back untouched. `unknown` because it
   * is the client's to choose and the host never reads it — only returns it.
   */
  id: unknown;
  ns: string;
  method: string;
  args: unknown[];
}

/** The answer to exactly one `InvokeFrame`. */
export type ResultFrame =
  | { id: unknown; kind: "result"; ok: true; result: unknown }
  | { id: unknown; kind: "result"; ok: false; error: string; code: string };

/**
 * Start hearing `ns.event`, optionally for one `key` only.
 *
 * A `pty.*` subscription names a `paneId`; everything else subscribes without
 * one. Membership is the whole filter — see `BridgeServer.subscribe`.
 */
export interface SubscribeFrame {
  kind: "subscribe";
  ns: string;
  event: string;
  key?: string;
}

/** Stop hearing what `SubscribeFrame` asked for. Same shape, same meaning. */
export interface UnsubscribeFrame {
  kind: "unsubscribe";
  ns: string;
  event: string;
  key?: string;
}

/**
 * Something happened: `ns.event(...args)`.
 *
 * The key rides along on the frame as well as filtering it. One connection
 * carries every pane the renderer has open, and `args` for `pty.output` is
 * the preload's `(data, seq)` — nothing in it says which pane, so without
 * this the client could only deliver a pane's bytes to all of them.
 */
export interface EventFrame {
  kind: "event";
  ns: string;
  event: string;
  args: unknown[];
  key?: string;
}

/**
 * What dispatch knows about a caller. A socket and a window are both this.
 *
 * Everything a transport is — a `WebSocket`, a `webContents`, a hello timer,
 * a reconnect — stays on the transport's side of this interface. What is on
 * this side is what `BridgeServer` genuinely needs: who is asking, what class
 * of caller they are, what to write in an audit line, and where to put a
 * frame. A transport that needed a sixth field here would be a transport
 * asking dispatch to care how it works.
 */
export interface BridgeConnection {
  /**
   * This caller's id, and so this renderer's id (ADR-179 D3): it rides out as
   * the origin of every layout command from here, and is what lets a renderer
   * tell its own `layout.changed` from every other viewer's. Stable across a
   * reconnect when the transport can manage it.
   */
  readonly id: string;
  /** `local` = an Electron renderer window; `device` = a paired `full` device. */
  readonly callerClass: "local" | "device";
  /** Audit identity, or null for a local caller (ADR-180 D4). */
  readonly deviceId: string | null;
  /** The audit line's human name for `deviceId`. Null for a local caller. */
  readonly deviceLabel: string | null;
  send(frame: EventFrame | ResultFrame): void;
}

/**
 * An `invoke` frame, or null if what arrived is not one.
 *
 * Decoding lives here rather than in either transport because both of them
 * receive from somewhere untrusted — a socket, or a renderer process — and a
 * second copy of "is `ns` a string" is a second chance to get it wrong. The
 * *arguments* are deliberately not validated: they are whatever the caller
 * sent, and every handler runs the same `assert*` validation the desktop path
 * runs (see `handlers.ts`).
 */
export function readInvokeFrame(
  raw: Record<string, unknown>,
): InvokeFrame | null {
  if (typeof raw.ns !== "string" || typeof raw.method !== "string") return null;
  return {
    kind: "invoke",
    id: raw.id,
    ns: raw.ns,
    method: raw.method,
    args: Array.isArray(raw.args) ? (raw.args as unknown[]) : [],
  };
}

/**
 * A `subscribe`/`unsubscribe` frame, or null if what arrived is not one.
 *
 * A malformed one is dropped rather than answered: subscription frames have
 * no id, so there is nowhere to send a complaint about them.
 */
export function readSubscribeFrame(
  raw: Record<string, unknown>,
  kind: "subscribe" | "unsubscribe",
): SubscribeFrame | UnsubscribeFrame | null {
  if (typeof raw.ns !== "string" || typeof raw.event !== "string") return null;
  const asked = {
    ns: raw.ns,
    event: raw.event,
    key: typeof raw.key === "string" ? raw.key : undefined,
  };
  return kind === "subscribe"
    ? { kind: "subscribe", ...asked }
    : { kind: "unsubscribe", ...asked };
}
