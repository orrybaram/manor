/**
 * HostServerClient — the desktop's end of the owner channel to one remote
 * host's host server (ADR-225 D4).
 *
 * The channel is one more stream on the host's provider
 * (`HostProvider.openServerChannel`: for ssh, `exec manor-host server-bridge`
 * on the shared ControlMaster). The box's end says the owner hello for us
 * and the provider reads the server's reply, so the stream this side gets is
 * the bridge protocol itself (`bridge/types.ts`), one JSON frame per line —
 * the same frames the phone speaks: `invoke` frames answered by `result`
 * frames by id, and `subscribe` / `unsubscribe` frames answered by `event`
 * frames (ADR-227 D4). Calls are typed from the host server's own table
 * (`api`, `HostServerApi`).
 *
 * **Subscriptions outlive the channel.** `subscribe` files the listener in a
 * `SubscriptionRegistry` (the one the web transport keeps), which is the
 * truth of what the server should be sending: every channel that comes up
 * is told all of it before `connected` is reported, so a server restart or
 * a host that drops and comes back loses no subscription. Events sent while
 * the channel was down are not replayed; whoever cares re-reads on
 * `connected` (`HostProxy` takes a fresh snapshot).
 *
 * `RemoteHostConnection` owns one per remote host, beside its hook feed, and
 * drives it with the host's lifecycle: `hostConnected` when the host
 * connects or comes back, `hostLost` when it drops, `dispose` with it.
 *
 * **Unsupported is quiet.** A box with no host server to reach — a
 * `manor-host` whose `server-bridge` exits non-zero, a provider with no
 * server channel, a server that refuses the owner — marks this client
 * `unsupported`, logs once, and stays that way until the host reconnects
 * (`hostConnected`), which is also when bootstrap may have installed a newer
 * `manor-host`. Never an error toast: in slice 1 a host server is a bonus
 * for the phone, not something the desktop needs.
 *
 * A channel that was up and drops while the host is still connected (the
 * server restarted for an upgrade) is retried with backoff instead. Whoever
 * re-sends what the server should hold listens for `connected`
 * (`BackendRegistry.onHostServerStateChange`, `host-server-sync.ts`).
 */

import type { Duplex } from "node:stream";
import { errorMessage } from "../lib/errors";
import type { ClientOf } from "../bridge/contract";
import { BridgeUnavailableError, settleResult } from "../bridge/settle";
import type {
  EventFrame,
  ResultFrame,
  SubscribeFrame,
  UnsubscribeFrame,
} from "../bridge/types";
import type { HostHandlers } from "../host-server/handlers";
import { createLineReader } from "../terminal-host/line-reader";
import { SubscriptionRegistry, type Listener } from "../../src/bridge/subscription-registry";

/**
 * The host server's table as the owner calls it: `api.hostServer.status()`,
 * `api.remoteControl.pair(label)`, … Types only; a handler's signature there
 * is its signature here.
 */
export type HostServerApi = ClientOf<HostHandlers>;

export type HostServerClientState =
  /** The host is not connected, so neither is this. */
  | "idle"
  | "connecting"
  | "connected"
  /** Was connected; the channel dropped and is being retried. */
  | "disconnected"
  /** The box has no host server to reach; quiet until the host reconnects. */
  | "unsupported";

/** A call made while the channel is not up, or refused as unavailable. */
export class HostServerUnavailableError extends Error {
  constructor(
    readonly hostId: string,
    readonly state: HostServerClientState | "refused",
    message?: string,
  ) {
    super(message ?? `The host server on ${hostId} is ${state}`);
    this.name = "HostServerUnavailableError";
  }
}

export interface HostServerClientOptions {
  hostId: string;
  /**
   * Opens the stream to the box's host server. Null when the host's
   * provider has none; the client is then always `unsupported`.
   */
  open: (() => Promise<Duplex>) | null;
  /** How long an invoke waits for its result. */
  requestTimeoutMs?: number;
  /** Delay before re-dialling a channel that dropped, by attempt. */
  retryDelayMs?: (attempt: number) => number;
  log?: Pick<Console, "info" | "warn">;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

function defaultRetryDelayMs(attempt: number): number {
  return Math.min(2_000 * 2 ** attempt, 60_000);
}

interface Pending {
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class HostServerClient {
  readonly hostId: string;
  /** The host server's methods, each an invoke on the channel. */
  readonly api: HostServerApi;
  private readonly openStream: (() => Promise<Duplex>) | null;
  private readonly requestTimeoutMs: number;
  private readonly retryDelayMs: (attempt: number) => number;
  private readonly log: Pick<Console, "info" | "warn">;

  private stateValue: HostServerClientState = "idle";
  /** The open stream, already past the server's hello. */
  private stream: Duplex | null = null;
  private connecting: Promise<boolean> | null = null;
  /** Bumped by everything that invalidates an attempt in flight. */
  private generation = 0;
  /** Whether a channel has come up since the host last connected. */
  private connectedThisEpoch = false;
  private hostUp = false;
  private disposed = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly stateListeners = new Set<(state: HostServerClientState) => void>();
  /** Every live event listener; told to each channel as it comes up. */
  private readonly subscriptions = new SubscriptionRegistry(
    (frame) => this.tellSubscription(frame),
    "host-server-client",
  );

  constructor(opts: HostServerClientOptions) {
    this.hostId = opts.hostId;
    this.openStream = opts.open;
    this.api = apiOver((ns, methodName, args) => this.invoke(ns, methodName, args));
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.retryDelayMs = opts.retryDelayMs ?? defaultRetryDelayMs;
    this.log = opts.log ?? console;
  }

  get state(): HostServerClientState {
    return this.stateValue;
  }

  /** Told whenever `state` changes. Returns the unsubscribe. */
  onStateChange(listener: (state: HostServerClientState) => void): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  // ── the host's lifecycle, as its `RemoteHostConnection` reports it ──

  /**
   * The host connected (or reconnected): forget any `unsupported` from
   * before — bootstrap may have installed a newer `manor-host` — and dial.
   */
  hostConnected(): void {
    if (this.disposed) return;
    this.hostUp = true;
    this.connectedThisEpoch = false;
    this.retryAttempt = 0;
    if (this.stateValue === "unsupported") this.setState("idle");
    void this.connect();
  }

  /** The host went away: so does the channel, until it comes back. */
  hostLost(): void {
    this.hostUp = false;
    this.close("idle");
  }

  /**
   * Dial, unless connected or dialling already. Resolves with whether the
   * channel is up; never rejects.
   */
  connect(): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    if (this.stateValue === "connected") return Promise.resolve(true);
    if (this.stateValue === "unsupported") return Promise.resolve(false);
    if (!this.connecting) {
      const attempt = this.dial(++this.generation).finally(() => {
        if (this.connecting === attempt) this.connecting = null;
      });
      this.connecting = attempt;
    }
    return this.connecting;
  }

  /** Let go for good. */
  dispose(): void {
    this.disposed = true;
    this.hostUp = false;
    this.close("idle");
    this.stateListeners.clear();
  }

  // ── calls ──

  /**
   * `ns.method(...args)` on the host server: what `api` calls, and what a
   * caller holding a method only by name (`HostProxy.invoke`) uses. Rejects
   * with `HostServerUnavailableError` when the channel is not up or the
   * server answers `unavailable:*`. `timeoutMs` overrides the client's
   * request timeout, for a call that clones or fetches.
   */
  invoke(
    ns: string,
    methodName: string,
    args: unknown[],
    opts: { timeoutMs?: number } = {},
  ): Promise<unknown> {
    const stream = this.stream;
    if (!stream || this.stateValue !== "connected") {
      return Promise.reject(new HostServerUnavailableError(this.hostId, this.stateValue));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${ns}.${methodName} on ${this.hostId}'s host server timed out`));
      }, opts.timeoutMs ?? this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.write(stream, { kind: "invoke", id, ns, method: methodName, args });
    });
  }

  // ── events ──

  /**
   * Hear the host server's `ns.event`, for one `key` or (none) every key.
   * Kept across reconnects; returns the release, which is idempotent. The
   * listener gets the event's `args`, spread.
   */
  subscribe(
    ns: string,
    event: string,
    key: string | undefined,
    listener: Listener,
  ): () => void {
    return this.subscriptions.subscribe(ns, event, key, listener);
  }

  /** A first listener in or a last one out: tell the channel, if it is up. */
  private tellSubscription(frame: SubscribeFrame | UnsubscribeFrame): void {
    const stream = this.stream;
    if (stream && this.stateValue === "connected") this.write(stream, frame);
  }

  // ── the channel ──

  private async dial(generation: number): Promise<boolean> {
    const current = () => !this.disposed && this.generation === generation;
    this.clearRetry();
    if (!this.openStream) {
      this.markUnsupported("its provider has no host server channel");
      return false;
    }
    this.setState("connecting");
    let stream: Duplex;
    try {
      stream = await this.openStream();
    } catch (err) {
      if (current()) this.failBeforeHello(errorMessage(err));
      return false;
    }
    if (!current()) {
      stream.destroy();
      return false;
    }
    if (stream.destroyed) {
      this.failBeforeHello("the stream ended as it opened");
      return false;
    }
    this.stream = stream;
    stream.on(
      "data",
      createLineReader((line) => {
        const frame = parseFrame(line);
        if (frame?.kind === "result") this.onResult(frame as unknown as ResultFrame);
        else if (frame?.kind === "event") this.subscriptions.deliver(frame as unknown as EventFrame);
      }),
    );
    stream.on("error", () => {
      // Its `close` follows, and reports the drop.
    });
    stream.on("close", () => this.onDropped(stream));
    // What this side listens to, before anyone hears `connected` and reads:
    // an event raised after their read is then never missed.
    for (const frame of this.subscriptions.keys()) this.write(stream, frame);

    this.connectedThisEpoch = true;
    this.retryAttempt = 0;
    this.setState("connected");
    return true;
  }

  /**
   * The channel would not open: the stream ended (or was refused) before the
   * server said hello. On a host whose channel has not come up since it
   * connected, that is a box without a host server: `unsupported`. One that
   * was up a moment ago is a server restarting: retry.
   */
  private failBeforeHello(reason: string): void {
    if (this.connectedThisEpoch && this.hostUp) {
      this.setState("disconnected");
      this.scheduleRetry();
      return;
    }
    this.markUnsupported(reason);
  }

  private markUnsupported(reason: string): void {
    if (this.stateValue === "unsupported") return;
    // Once per host connection: `hostConnected` clears it.
    this.log.info(
      `[host-server-client] ${this.hostId} has no host server to reach (${reason}); carrying on without one`,
    );
    this.setState("unsupported");
  }

  private onDropped(stream: Duplex): void {
    if (this.stream !== stream) return;
    this.stream = null;
    this.rejectPending("the host server channel closed");
    if (this.disposed || !this.hostUp) {
      this.setState("idle");
      return;
    }
    this.setState("disconnected");
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.disposed || !this.hostUp) return;
    const delay = this.retryDelayMs(this.retryAttempt++);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.hostUp && !this.disposed) void this.connect();
    }, delay);
    this.retryTimer.unref?.();
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private onResult(frame: ResultFrame): void {
    const id = typeof frame.id === "number" ? frame.id : NaN;
    const waiting = this.pending.get(id);
    if (!waiting) return;
    this.pending.delete(id);
    clearTimeout(waiting.timer);
    try {
      waiting.resolve(settleResult(frame));
    } catch (err) {
      waiting.reject(
        err instanceof BridgeUnavailableError
          ? new HostServerUnavailableError(this.hostId, "refused", err.message)
          : (err as Error),
      );
    }
  }

  private write(stream: Duplex, frame: unknown): void {
    if (stream.destroyed || !stream.writable) return;
    try {
      stream.write(JSON.stringify(frame) + "\n");
    } catch {
      // A stream that died mid-write; its `close` reports it.
    }
  }

  /** Drop the channel (and anything waiting on it), landing in `state`. */
  private close(state: HostServerClientState): void {
    this.generation++;
    this.connecting = null;
    this.clearRetry();
    const stream = this.stream;
    this.stream = null;
    this.rejectPending("the host server channel closed");
    stream?.destroy();
    this.setState(state);
  }

  private rejectPending(reason: string): void {
    for (const [id, waiting] of this.pending) {
      clearTimeout(waiting.timer);
      waiting.reject(new HostServerUnavailableError(this.hostId, "disconnected", reason));
      this.pending.delete(id);
    }
  }

  private setState(state: HostServerClientState): void {
    if (this.stateValue === state) return;
    this.stateValue = state;
    for (const listener of [...this.stateListeners]) {
      try {
        listener(state);
      } catch (err) {
        this.log.warn(`[host-server-client] state listener threw: ${errorMessage(err)}`);
      }
    }
  }
}

/** One line as a frame object, or null when it is not JSON (or not an object). */
function parseFrame(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * `HostServerApi` over one invoke function: `api.ns.method(...args)` is
 * `invoke("ns", "method", args)`. The host table's namespaces are one level
 * deep, so two proxies are the whole of it.
 */
function apiOver(
  invoke: (ns: string, methodName: string, args: unknown[]) => Promise<unknown>,
): HostServerApi {
  const namespaces = new Map<string, unknown>();
  return new Proxy({} as HostServerApi, {
    get(_target, ns) {
      if (typeof ns !== "string") return undefined;
      let methods = namespaces.get(ns);
      if (!methods) {
        methods = new Proxy(
          {},
          {
            get: (_t, methodName) =>
              typeof methodName === "string"
                ? (...args: unknown[]) => invoke(ns, methodName, args)
                : undefined,
          },
        );
        namespaces.set(ns, methods);
      }
      return methods;
    },
  });
}
