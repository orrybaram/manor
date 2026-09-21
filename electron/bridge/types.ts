/**
 * The bridge protocol, in one file (ADR-180 D1).
 *
 * The frames on the wire, the one thing dispatch knows about a caller, and the
 * constants both ends of a transport must agree on (channel names, close
 * codes, the keyless-subscription key). `BridgeServer` speaks these; a
 * transport carries them. Which is why this file imports nothing: a
 * `WebSocket`, an `ipcMain` channel and whatever carries these next must all
 * be describable in the same five shapes, and a type that reached for `ws`
 * here would have decided that question for them.
 *
 * What this is *not*: it is not the handler table (`handlers.ts` is), not the
 * dispatcher (`server.ts` is), and not a client. `src/bridge/client.ts` holds
 * the renderers' half — and imports this file rather than mirroring it, which
 * is the other reason the import list above has to stay empty: these shapes
 * are read from the main process, the preload, an Electron renderer and a
 * browser bundle, and only a file with no dependencies can be read from all
 * four.
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
 * The key a subscription that named none is filed under — by `BridgeServer`,
 * and by `SubscriptionRegistry` on the client side of either transport. Kept
 * off the wire: a subscribe frame with no `key` means exactly this, and
 * sending it would be saying the same thing twice.
 */
export const ALL_KEYS = "*";

/**
 * The desktop transport's IPC channels (ADR-180 D2): the main process listens
 * on them (`transports/ipc.ts`) and the preload sends on them. Here rather
 * than in either, because the preload may not import the main side — that
 * module reaches for `ipcMain` and, through the handler table, the whole main
 * process.
 */
/** An `InvokeFrame`, answered with its `ResultFrame` (`ipcMain.handle`). */
export const BRIDGE_INVOKE = "bridge:invoke";
/** A `SubscribeFrame`. No reply. */
export const BRIDGE_SUBSCRIBE = "bridge:subscribe";
/** An `UnsubscribeFrame`. No reply. */
export const BRIDGE_UNSUBSCRIBE = "bridge:unsubscribe";
/** Main → renderer: one `EventFrame`. */
export const BRIDGE_EVENT = "bridge:event";
/**
 * "Who am I?", answered synchronously (ADR-179 D3, ADR-180 ticket 6). The one
 * channel that carries no frame: the preload has to know its `rendererId`
 * before the page's first line runs, and `webContents.id` is already in hand.
 */
export const BRIDGE_RENDERER_ID = "bridge:rendererId";

/**
 * The WebSocket transport's close codes, in the application range so they
 * read as the HTTP statuses they mirror: the client can tell "your token is
 * wrong, re-pair" from "your token is right and this tier cannot do this",
 * and stops dialling on either.
 */
/** No `hello`, a bad token, or a revoked device. */
export const CLOSE_UNAUTHORIZED = 4401;
/** A valid token for a device below the `full` tier. */
export const CLOSE_FORBIDDEN = 4403;

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

/** Anything a client sends. */
export type ClientFrame = InvokeFrame | SubscribeFrame | UnsubscribeFrame;

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
