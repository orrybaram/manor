/**
 * HostServerClient — the desktop's end of the owner channel to one remote
 * host's host server (ADR-218 D4).
 *
 * The channel is one more stream on the host's provider
 * (`HostProvider.openServerChannel`: for ssh, `exec manor-host server-bridge`
 * on the shared ControlMaster). The box's end says the owner hello for us
 * and then pipes the stream to the server's unix socket, so what this side
 * reads and writes is the bridge protocol itself (`bridge/types.ts`), one
 * JSON frame per line — the same frames the phone speaks, as an invoke
 * client: `invoke` frames answered by `result` frames by id, `subscribe`
 * frames answered by `event` frames.
 *
 * The first line that parses as `{"type":"hello","ok":true,…}` is the
 * server accepting the owner; anything before it that is not JSON is login
 * shell noise and skipped, as `SshTransport` skips it hunting for the
 * daemon's `bridgeHello`.
 *
 * **Unsupported is quiet.** A box with no host server to reach — a
 * `manor-host` whose `server-bridge` exits non-zero, a provider with no
 * server channel, a stream that ends before the hello — marks this client
 * `unsupported`, logs once, and stays that way until the host reconnects
 * (`hostConnected`), which is also when bootstrap may have installed a newer
 * `manor-host`. Never an error toast: in slice 1 a host server is a bonus
 * for the phone, not something the desktop needs.
 *
 * A channel that was up and drops while the host is still connected (the
 * server restarted for an upgrade) is retried with backoff instead.
 *
 * Every connect — the first, and each after a host reconnect or a drop —
 * runs `onConnected`, which is where the registry's owner re-sends the
 * manifest and layout (`host-server-sync.ts`).
 */

import type { Duplex } from "node:stream";
import { errorMessage } from "../lib/errors";
import type { HostLayoutSnapshot } from "../host-server/layout";
import type { HostManifest } from "../host-server/manifest";
import type { HostServerStatus } from "../host-server/relay";
import type { PairResult } from "../remote-control/controller";
import type { VapidKeys } from "../remote-control/push";
import type { RemoteDeviceInfo } from "../remote-control/devices";
import { createLineReader } from "../terminal-host/line-reader";
import { isUnavailableCode, type EventFrame, type ResultFrame } from "../bridge/types";

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
  /** After every successful connect: re-send what the server should hold. */
  onConnected?: (client: HostServerClient) => void | Promise<void>;
  /** How long to wait for the server's hello reply. */
  helloTimeoutMs?: number;
  /** How long an invoke waits for its result. */
  requestTimeoutMs?: number;
  /** Delay before re-dialling a channel that dropped, by attempt. */
  retryDelayMs?: (attempt: number) => number;
  log?: Pick<Console, "info" | "warn">;
}

const DEFAULT_HELLO_TIMEOUT_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

function defaultRetryDelayMs(attempt: number): number {
  return Math.min(2_000 * 2 ** attempt, 60_000);
}

interface Pending {
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** One open stream and what it has said so far. */
interface Channel {
  stream: Duplex;
  helloed: boolean;
}

type EventListener = (...args: unknown[]) => void;

export class HostServerClient {
  readonly hostId: string;
  private readonly openStream: (() => Promise<Duplex>) | null;
  private readonly onConnected: HostServerClientOptions["onConnected"];
  private readonly helloTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly retryDelayMs: (attempt: number) => number;
  private readonly log: Pick<Console, "info" | "warn">;

  private stateValue: HostServerClientState = "idle";
  private channel: Channel | null = null;
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
  private readonly listeners = new Map<string, Set<EventListener>>();
  private readonly stateListeners = new Set<(state: HostServerClientState) => void>();

  constructor(opts: HostServerClientOptions) {
    this.hostId = opts.hostId;
    this.openStream = opts.open;
    this.onConnected = opts.onConnected;
    this.helloTimeoutMs = opts.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
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

  // ── the host's lifecycle, as the registry reports it ──

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
    this.listeners.clear();
    this.stateListeners.clear();
  }

  // ── calls ──

  /**
   * `ns.method(...args)` on the host server. Rejects with
   * `HostServerUnavailableError` when the channel is not up or the server
   * answers `unavailable:*`.
   */
  invoke<T>(ns: string, methodName: string, ...args: unknown[]): Promise<T> {
    const channel = this.channel;
    if (!channel?.helloed || this.stateValue !== "connected") {
      return Promise.reject(new HostServerUnavailableError(this.hostId, this.stateValue));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${ns}.${methodName} on ${this.hostId}'s host server timed out`));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.write(channel, { kind: "invoke", id, ns, method: methodName, args });
    });
  }

  /**
   * Hear `ns.event` from the host server. Survives reconnects: every new
   * channel subscribes again. Returns the unsubscribe.
   */
  subscribe(ns: string, event: string, listener: EventListener): () => void {
    const name = `${ns}.${event}`;
    let set = this.listeners.get(name);
    if (!set) {
      set = new Set();
      this.listeners.set(name, set);
      if (this.channel?.helloed) this.write(this.channel, { kind: "subscribe", ns, event });
    }
    set.add(listener);
    return () => {
      const current = this.listeners.get(name);
      if (!current?.delete(listener) || current.size > 0) return;
      this.listeners.delete(name);
      if (this.channel?.helloed) this.write(this.channel, { kind: "unsubscribe", ns, event });
    };
  }

  /** The desktop's projects on this host (ADR-218 D4, D8). */
  syncManifest(manifest: HostManifest): Promise<true> {
    return this.invoke("hostServer", "syncManifest", manifest);
  }

  /** The desktop's VAPID pair, so this server's pushes share its key (ADR-218 D3). */
  setVapidKeys(keys: VapidKeys): Promise<true> {
    return this.invoke("hostServer", "setVapidKeys", keys);
  }

  /** The desktop's layout for this host's workspaces (ADR-218 D5). */
  syncLayout(snapshot: HostLayoutSnapshot): Promise<true> {
    return this.invoke("hostServer", "syncLayout", snapshot);
  }

  /** Version, uptime, relay room, paired devices and push endpoints. */
  status(): Promise<HostServerStatus> {
    return this.invoke("hostServer", "status");
  }

  /** Pair a phone to this host's own room (ADR-218 D3). */
  pair(label: string): Promise<PairResult> {
    return this.invoke("remoteControl", "pair", label);
  }

  listDevices(): Promise<RemoteDeviceInfo[]> {
    return this.invoke("remoteControl", "listDevices");
  }

  /** Revoke a phone; resolves with the devices left. */
  revoke(deviceId: string): Promise<RemoteDeviceInfo[]> {
    return this.invoke("remoteControl", "revoke", deviceId);
  }

  /** "Reset pairing keys": a new room, every phone revoked (ADR-218 D6). */
  resetIdentity(): Promise<HostServerStatus> {
    return this.invoke("hostServer", "resetIdentity");
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
    const channel: Channel = { stream, helloed: false };
    this.channel = channel;

    const helloed = await new Promise<boolean>((resolve) => {
      let settled = false;
      let lastError: Error | null = null;
      const settle = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ok);
      };
      const timer = setTimeout(() => {
        lastError = new Error(`no hello within ${Math.round(this.helloTimeoutMs / 1000)}s`);
        stream.destroy();
      }, this.helloTimeoutMs);
      timer.unref?.();

      stream.on(
        "data",
        createLineReader((line) => {
          const frame = parseFrame(line);
          if (!channel.helloed) {
            if (!frame) return; // login-shell noise ahead of the hello
            if (frame.type === "hello" && frame.ok === true) {
              channel.helloed = true;
              settle(true);
              return;
            }
            if (frame.kind === "close") {
              lastError = new Error(
                `refused (${String(frame.code)}${frame.reason ? `: ${String(frame.reason)}` : ""})`,
              );
            }
            return;
          }
          if (frame) this.onFrame(frame);
        }),
      );
      stream.on("error", (err) => {
        lastError = err;
      });
      stream.on("close", () => {
        if (!channel.helloed) {
          settle(false);
          if (current() && this.channel === channel) {
            this.channel = null;
            this.failBeforeHello(lastError ? errorMessage(lastError) : "the stream ended before the hello");
          }
          return;
        }
        this.onDropped(channel);
      });
    });
    if (!helloed || !current()) return false;

    this.connectedThisEpoch = true;
    this.retryAttempt = 0;
    this.setState("connected");
    for (const name of this.listeners.keys()) {
      const at = name.lastIndexOf(".");
      this.write(channel, { kind: "subscribe", ns: name.slice(0, at), event: name.slice(at + 1) });
    }
    try {
      await this.onConnected?.(this);
    } catch (err) {
      this.log.warn(
        `[host-server-client] ${this.hostId}: re-sending after connect failed: ${errorMessage(err)}`,
      );
    }
    return this.stateValue === "connected";
  }

  /**
   * The stream ended before the server said hello. On a host whose channel
   * has not come up since it connected, that is a box without a host server:
   * `unsupported`. One that was up a moment ago is a server restarting:
   * retry.
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

  private onDropped(channel: Channel): void {
    if (this.channel !== channel) return;
    this.channel = null;
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

  private onFrame(frame: Record<string, unknown>): void {
    if (frame.kind === "result") {
      const id = typeof frame.id === "number" ? frame.id : NaN;
      const waiting = this.pending.get(id);
      if (!waiting) return;
      this.pending.delete(id);
      clearTimeout(waiting.timer);
      const result = frame as unknown as ResultFrame;
      if (result.ok) {
        waiting.resolve(result.result);
      } else if (isUnavailableCode(result.code)) {
        waiting.reject(new HostServerUnavailableError(this.hostId, "refused", result.error));
      } else {
        waiting.reject(new Error(result.error));
      }
      return;
    }
    if (frame.kind === "event") {
      const event = frame as unknown as EventFrame;
      const set = this.listeners.get(`${event.ns}.${event.event}`);
      if (!set) return;
      for (const listener of [...set]) {
        try {
          listener(...(Array.isArray(event.args) ? event.args : []));
        } catch (err) {
          this.log.warn(`[host-server-client] ${this.hostId}: listener threw: ${errorMessage(err)}`);
        }
      }
    }
  }

  private write(channel: Channel, frame: unknown): void {
    if (channel.stream.destroyed || !channel.stream.writable) return;
    try {
      channel.stream.write(JSON.stringify(frame) + "\n");
    } catch {
      // A stream that died mid-write; its `close` reports it.
    }
  }

  /** Drop the channel (and anything waiting on it), landing in `state`. */
  private close(state: HostServerClientState): void {
    this.generation++;
    this.connecting = null;
    this.clearRetry();
    const channel = this.channel;
    this.channel = null;
    this.rejectPending("the host server channel closed");
    channel?.stream.destroy();
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
