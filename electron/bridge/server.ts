/**
 * The host surface (ADR-180 D1).
 *
 * One table of what this machine can do, one dispatcher for it, one registry
 * of who is connected, and one fan-out of everything that happens. A caller
 * reaches it as a `BridgeConnection` — today a socket from a paired device
 * (`transports/ws.ts`), and under D2 an Electron renderer window as well —
 * and this class cannot tell which, on purpose: that is the whole of D1.
 *
 * All of it was `WsBridgeServer` until ADR-180, and is lifted out of it
 * unchanged. What was removed is everything a WebSocket needs and a window
 * does not: the hello frame, the five-second timeout, the close codes, the
 * `readyState` check and JSON. A transport does those; `send(frame)` is the
 * whole of what this side asks of one.
 *
 * **Authentication is not here.** Remote control decides whether a token is
 * good and whether its device is `full`; this class never learns what a token
 * is. It is told the answer once, as a `callerClass`, and does three things
 * with it: `LOCAL_ONLY` (D4), the audit line, and handing it to the handler
 * as `ctx.caller`.
 *
 * **Subscription membership is the whole event filter.** A connection that
 * never subscribed to pane B never sees a byte of B's output, however much of
 * it the daemon produces. Nothing here decides *when* something changed:
 * `renderer-broadcast.ts` and the PTY stream do, and this class forwards.
 */

import type { StreamEvent } from "../terminal-host/types";
import type { HostDeps } from "../ipc/types";
import { RemoteAuditLog } from "../remote-control/audit";
import {
  addRendererBroadcastSink,
  type RendererBroadcast,
} from "../renderer-broadcast";
import { onAttachmentChange, ownerOf, releaseViewer } from "../pty-attachments";
import {
  HANDLERS,
  LOCAL_ONLY,
  MUTATING,
  SECRET_FIRST_ARG,
  type BridgeHandler,
} from "./handlers";
import type { EventArgs, EventNs, EventOf } from "./events";
import { sessionGrid } from "./handlers/pty";
import type { HandlerCtx } from "./method";
import {
  ALL_KEYS,
  UNAVAILABLE_CODE,
  readInvokeFrame,
  readSubscribeFrame,
  type BridgeConnection,
  type EventFrame,
  type InvokeFrame,
  type ResultFrame,
} from "./types";

/**
 * A connection and what it asked to hear.
 *
 * The subscription map is held here rather than on `BridgeConnection` so that
 * a transport cannot forget to make one, and cannot read another connection's.
 */
interface Registered {
  connection: BridgeConnection;
  /**
   * `ns.event` → the keys subscribed to. A `pty.*` subscription names a
   * `paneId`; everything else subscribes without one and gets `ALL_KEYS`.
   */
  subscriptions: Map<string, Set<string>>;
}

interface BridgeServerOptions {
  audit?: RemoteAuditLog;
  /** Overridable so a test can assert dispatch without a real `HostDeps`. */
  handlers?: Record<string, BridgeHandler>;
}

export class BridgeServer {
  private readonly connections = new Map<string, Registered>();
  private readonly audit: RemoteAuditLog;
  private readonly handlers: Record<string, BridgeHandler>;
  private readonly unsubscribeBroadcasts: () => void;
  private readonly unsubscribeAttachments: () => void;
  private readonly disconnectSinks = new Set<(connectionId: string) => void>();

  constructor(
    private readonly deps: HostDeps,
    options: BridgeServerOptions = {},
  ) {
    this.audit = options.audit ?? new RemoteAuditLog();
    this.handlers = options.handlers ?? HANDLERS;
    this.unsubscribeBroadcasts = addRendererBroadcastSink((broadcast) =>
      this.onRendererBroadcast(broadcast),
    );
    // D6: told whenever `pty-attachments.ts` decides a pane's winsize owner
    // changed — a viewer's `pty.create`/`close`/`detach`, a desktop window
    // attaching or dying, or (below) a connection of this server's own
    // dropping. One place turns that into a push, whichever side caused it.
    this.unsubscribeAttachments = onAttachmentChange((paneId) => {
      void this.onOwnerChanged(paneId);
    });
  }

  /** Callers currently attached, across every transport. */
  get size(): number {
    return this.connections.size;
  }

  /**
   * A transport has a caller that got past whatever it uses for a door.
   *
   * Everything before this — a token, a hello, a sender check — is the
   * transport's business. After it, a connection is a connection.
   */
  accept(connection: BridgeConnection): void {
    this.connections.set(connection.id, {
      connection,
      subscriptions: new Map(),
    });
  }

  /**
   * That caller is gone.
   *
   * A dead connection releases every pane it was a viewer of — a browser
   * that vanished mid-session, or a window that closed without unmounting
   * its panes, must not keep outvoting the viewers still there for who owns
   * the winsize (ADR-179 D6). Transports call this only for connections they
   * actually accepted: one that never got past authentication never attached
   * anything, so there is nothing to release and nobody to tell.
   */
  drop(connectionId: string): void {
    if (!this.connections.delete(connectionId)) return;
    releaseViewer(connectionId);
    for (const cb of this.disconnectSinks) cb(connectionId);
  }

  /**
   * Told when a connection drops, after this class has released whatever it
   * held. `app-lifecycle.ts` hands a closed window's claim
   * back to the primary from here (`LayoutStore.releaseWindow`), so "a window
   * went away" is decided in one place for every transport.
   */
  onDisconnect(cb: (connectionId: string) => void): () => void {
    this.disconnectSinks.add(cb);
    return () => {
      this.disconnectSinks.delete(cb);
    };
  }

  /**
   * One frame from a caller, decoded and routed.
   *
   * `raw` is whatever the transport received — a parsed socket message, or
   * an IPC payload — and nothing about it is trusted. An invoke is answered:
   * with its result, or with `bad-frame` when it does not name a method. A
   * subscribe or unsubscribe has no id, so it is never answered, and a
   * malformed one is dropped. An unknown `kind` is ignored rather than fatal:
   * a newer client sending a frame this version does not have should
   * degrade, not disconnect.
   *
   * Returns the answer rather than sending it, for the reason `dispatch`
   * does.
   */
  async receive(
    connection: BridgeConnection,
    raw: unknown,
  ): Promise<ResultFrame | null> {
    const frame =
      typeof raw === "object" && raw !== null
        ? (raw as Record<string, unknown>)
        : {};
    switch (frame.kind) {
      case "invoke": {
        const invoke = readInvokeFrame(frame);
        if (!invoke) {
          return {
            id: frame.id,
            kind: "result",
            ok: false,
            error: "invoke needs a string ns and method",
            code: "bad-frame",
          };
        }
        return this.dispatch(connection, invoke);
      }
      case "subscribe":
      case "unsubscribe": {
        const asked = readSubscribeFrame(frame, frame.kind);
        if (!asked) return null;
        if (asked.kind === "subscribe") {
          this.subscribe(connection, asked.ns, asked.event, asked.key);
        } else {
          this.unsubscribe(connection, asked.ns, asked.event, asked.key);
        }
        return null;
      }
      default:
        return null;
    }
  }

  /**
   * Run `ns.method` for a caller and hand back the frame to answer it with.
   *
   * Returns the result rather than sending it: the transport owns the write,
   * because the transport is what knows whether there is still anything to
   * write to.
   */
  async dispatch(
    connection: BridgeConnection,
    frame: InvokeFrame,
  ): Promise<ResultFrame> {
    const id = frame.id;
    const args = frame.args;
    const key = `${frame.ns}.${frame.method}`;
    const handler = this.handlers[key];
    // Absent from the table, or on it but refused to this class of caller
    // (D4) — one answer for both, because the difference is none of a
    // device's business and the client renders the same empty state either
    // way.
    //
    // The two differ in the audit log, though, and on purpose. A method
    // absent from the table is a stale client or a typo. A `LOCAL_ONLY`
    // method is one that exists, is real power, and was refused *because*
    // it was asked for over a paired device — `remoteControl.pair` above all.
    // That is exactly the line an owner reading this log after a lost phone
    // needs to see.
    const refusedLocalOnly =
      !!handler &&
      connection.callerClass === "device" &&
      LOCAL_ONLY.has(key);
    if (refusedLocalOnly) {
      this.auditInvoke(connection, key, args, "rejected", 403);
    }
    if (!handler || refusedLocalOnly) {
      return {
        id,
        kind: "result",
        ok: false,
        error: `${key} is not available in the browser`,
        code: UNAVAILABLE_CODE,
      };
    }

    const audited = MUTATING.has(key);
    // Widened here and nowhere else — see `BridgeHandler`. Every handler
    // validates what it is given before it does anything with it.
    const call = handler as (ctx: HandlerCtx, ...args: unknown[]) => unknown;
    // Who sent it comes from the connection, never from the frame: a caller
    // does not get to say which caller it is (ADR-179 D3).
    const ctx: HandlerCtx = {
      deps: this.deps,
      caller: { id: connection.id, callerClass: connection.callerClass },
    };
    try {
      const result = await call(ctx, ...args);
      if (audited) this.auditInvoke(connection, key, args, "sent", 200);
      return { id, kind: "result", ok: true, result };
    } catch (err) {
      if (audited) this.auditInvoke(connection, key, args, "failed", 500);
      return {
        id,
        kind: "result",
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        code: "failed",
      };
    }
  }

  /** Start sending this connection `ns.event`, for `key` or for everything. */
  subscribe(
    connection: BridgeConnection,
    ns: string,
    event: string,
    key?: string,
  ): void {
    const registered = this.connections.get(connection.id);
    if (!registered) return;
    const name = `${ns}.${event}`;
    const keys = registered.subscriptions.get(name);
    if (keys) keys.add(key ?? ALL_KEYS);
    else registered.subscriptions.set(name, new Set([key ?? ALL_KEYS]));
  }

  /** Stop. An unsubscribe for something never subscribed to is not an error. */
  unsubscribe(
    connection: BridgeConnection,
    ns: string,
    event: string,
    key?: string,
  ): void {
    const registered = this.connections.get(connection.id);
    if (!registered) return;
    const name = `${ns}.${event}`;
    const keys = registered.subscriptions.get(name);
    if (!keys) return;
    keys.delete(key ?? ALL_KEYS);
    if (keys.size === 0) registered.subscriptions.delete(name);
  }

  /**
   * One PTY stream event, forwarded to the connections that asked for that
   * pane.
   *
   * Called from the single `backend.pty.onEvent` subscription in
   * `app-lifecycle.ts` rather than taking one of its own: the daemon client
   * holds exactly one handler, and a second `onEvent` call would replace the
   * one that feeds the desktop windows.
   */
  handleStreamEvent(event: StreamEvent): void {
    // The argument shapes are the listeners', verbatim: `onOutput(paneId,
    // (data, seq))`, `onResized(paneId, (cols, rows))`, and so on — each one
    // the row of `BridgeEvents.pty` it is published as.
    const pane = event.sessionId;
    switch (event.type) {
      case "data":
        this.publish("pty", "output", [event.data, event.seq], pane);
        return;
      case "exit":
        this.publish("pty", "exit", [], pane);
        return;
      case "cwd":
        this.publish("pty", "cwd", [event.cwd], pane);
        return;
      case "error":
        this.publish("pty", "error", [event.message], pane);
        return;
      case "agentStatus":
        this.publish("pty", "agentStatus", [event.agent], pane);
        return;
      case "resized":
        this.publish("pty", "resized", [event.cols, event.rows], pane);
        return;
    }
  }

  /**
   * Forget every connection. The transports close them; this releases what
   * they were holding.
   */
  dropAll(): void {
    for (const id of [...this.connections.keys()]) this.drop(id);
  }

  /** Release the sinks. The process is exiting; there is no restart. */
  dispose(): void {
    this.dropAll();
    this.unsubscribeBroadcasts();
    this.unsubscribeAttachments();
  }

  /**
   * A pane's winsize owner changed: tell every connection watching it whether
   * it is the owner now (D6).
   *
   * The grid comes from the daemon rather than from whoever just attached,
   * because the two cases this fires for disagree about whose number is
   * current: a bridge viewer's own `pty.create` already resized the session
   * to *its* grid before this runs, and an ownership hand-off with no new
   * create — the owner disconnected, or a desktop window let go — resizes
   * nothing at all, so the daemon's answer is the only one that is still
   * true either way.
   */
  private async onOwnerChanged(paneId: string): Promise<void> {
    if (this.connections.size === 0) return;
    const grid = await sessionGrid(this.deps, paneId);
    if (!grid) return;
    const owner = ownerOf(paneId);
    // One frame per connection, not one fanned out: `owner` is each
    // connection's own answer. Subscription is still honoured — a viewer
    // that never asked about this pane does not hear that it isn't the owner
    // of it.
    for (const id of this.connections.keys()) {
      const isOwner = owner?.connectionId === id;
      this.sendTo(
        id,
        "pty",
        "winsizeOwner",
        [{ paneId, cols: grid.cols, rows: grid.rows, owner: isOwner }],
        paneId,
      );
    }
  }

  /**
   * A change the desktop windows were told about, forwarded to everyone.
   * Keyless: `projects.changed` is about the machine, not about one pane.
   *
   * The names are `BridgeEvents`', and they line up with the listeners in
   * `SUBSCRIPTIONS` one-for-one, arguments included (`./events.ts`):
   *
   * | frame                   | listener                         |
   * | ----------------------- | -------------------------------- |
   * | `projects.changed`      | `projects.onChanged(cb)`         |
   * | `agents.updated`        | `agents.onUpdate(cb)`            |
   * | `preferences.changed`   | `preferences.onChange(cb)`       |
   * | `keybindings.changed`   | `keybindings.onChange(cb)`       |
   * | `notifications.changed` | `notifications.onChanged(cb)`    |
   * | `stats.changed`         | `stats.onChanged(cb)`            |
   * | `remoteControl.status`  | `remoteControl.onStatus(cb)`     |
   * | `layout.changed`        | `layout.onChanged(cb)`           |
   * | `theme.changed`         | `theme.onChanged(cb)`            |
   *
   * `layout.changed` is the one that carries a *whole* workspace layout
   * (ADR-179 D1): the server is the only writer, so a renderer replaces its
   * replica rather than patching it.
   *
   * `theme.changed` keeps a second desktop window and every browser on the
   * bridge in sync with the theme a `theme.setSelected` call chose, rather
   * than each holding the theme it last remounted with.
   *
   * ADR-180 D5 adds the addressed half: a broadcast carrying a `to` is for
   * exactly one connection — `appCommands.command` to the primary window,
   * `menu.command` to the focused one, `projects.worktreeProgress` to
   * whoever asked for the worktree. Broadcast cannot express those, and a
   * second mechanism for them would be a second thing to keep honest, so
   * they arrive here and take the one-connection door instead.
   */
  private onRendererBroadcast(broadcast: RendererBroadcast): void {
    // Typed where it was published (`publishRendererBroadcast` /
    // `publishToRenderer`), so it goes out as it came in.
    const frame: EventFrame = {
      kind: "event",
      ns: broadcast.ns,
      event: broadcast.event,
      args: broadcast.args,
    };
    if (broadcast.to !== null) this.deliverTo(broadcast.to, frame);
    else this.fanOut(frame);
  }

  /** `ns.event` to every connection that asked for it, at `key` if keyed. */
  private publish<N extends EventNs, E extends EventOf<N>>(
    ns: N,
    event: E,
    args: EventArgs<N, E>,
    key: string | null,
  ): void {
    this.fanOut(eventFrame(ns, event, args, key));
  }

  /** `ns.event` to one connection, if it asked for it. */
  private sendTo<N extends EventNs, E extends EventOf<N>>(
    connectionId: string,
    ns: N,
    event: E,
    args: EventArgs<N, E>,
    key: string | null,
  ): void {
    this.deliverTo(connectionId, eventFrame(ns, event, args, key));
  }

  private fanOut(frame: EventFrame): void {
    if (this.connections.size === 0) return;
    for (const registered of this.connections.values()) {
      if (!this.wants(registered, frame)) continue;
      registered.connection.send(frame);
    }
  }

  private deliverTo(connectionId: string, frame: EventFrame): void {
    const registered = this.connections.get(connectionId);
    if (!registered) return;
    if (!this.wants(registered, frame)) return;
    registered.connection.send(frame);
  }

  /** Did this connection ask for this frame? Membership is the whole filter. */
  private wants(registered: Registered, frame: EventFrame): boolean {
    const keys = registered.subscriptions.get(`${frame.ns}.${frame.event}`);
    if (!keys) return false;
    if (frame.key === undefined) return true;
    return keys.has(frame.key) || keys.has(ALL_KEYS);
  }

  private auditInvoke(
    connection: BridgeConnection,
    route: string,
    args: unknown[],
    outcome: "sent" | "rejected" | "failed",
    status: number,
  ): void {
    // A local call is never audited: it is the user at the machine, and a log
    // line per window is a log of the app using itself (ADR-180 D4).
    const { deviceId, deviceLabel } = connection;
    if (deviceId === null || deviceLabel === null) return;
    this.audit.append({
      at: new Date().toISOString(),
      deviceId,
      deviceLabel,
      tier: "full",
      transport: "bridge",
      route,
      // Never a secret. `linear.connect`'s first argument is an API key, and
      // it is `LOCAL_ONLY` — so a refused attempt reaches this line, and
      // `bridgeTarget` would otherwise write the key a stolen token just
      // tried to use into the very log meant to catch it.
      target: SECRET_FIRST_ARG.has(route) ? null : bridgeTarget(args),
      // No bodies: the table's arguments are too varied to fish in safely,
      // and one of them is a keystroke.
      textLength: null,
      textSha256: null,
      interrupt: false,
      outcome,
      status,
    });
  }
}

/** An event frame; the key, when there is one, rides along on it. */
function eventFrame(
  ns: string,
  event: string,
  args: unknown[],
  key: string | null,
): EventFrame {
  return key === null
    ? { kind: "event", ns, event, args }
    : { kind: "event", ns, event, args, key };
}

/**
 * What an audited invoke was aimed at.
 *
 * The first primitive argument, which for every method in `MUTATING` is the
 * paneId, the project index or the project id — the same "what did it point
 * at" the HTTP audit line records from a path capture. Objects are skipped
 * rather than serialized: that is where the bodies are.
 */
function bridgeTarget(args: unknown[]): string | null {
  for (const arg of args) {
    if (typeof arg === "string") return arg;
    if (typeof arg === "number" && Number.isFinite(arg)) return String(arg);
  }
  return null;
}
