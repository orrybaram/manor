/**
 * BackendRegistry — every host Manor runs workspaces on, keyed by hostId
 * (ADR-160 §6).
 *
 * `"local"` is always present and is the `LocalBackend` Manor has always
 * had; remote hosts are registered from their persisted `HostSpec` and
 * connected lazily, in the background, never on the launch path.
 *
 * The registry owns three things callers should not have to think about:
 *
 * - **Status.** Each host is `disconnected` → `connecting` → `connected`,
 *   and a remote one moves to `reconnecting` / `error` as its backend
 *   reports `hostDisconnected` / `hostFailed`. `list()` exposes it (with the
 *   failure's reason, code and message), `onStatusChange` announces it.
 * - **Gating.** `get(hostId)` for a remote host hands out a view that waits
 *   for the connection before a pty call, and fails fast — kicking off a
 *   background connect — before a git, shell or ports call. Pollers
 *   therefore never sit on a host that is not there, and one unreachable
 *   host cannot stall the others. The local view is an ungated Proxy over
 *   the `LocalBackend` that calls every method straight through, so a
 *   local-only setup behaves exactly as before.
 * - **Stream events.** A `TerminalHostClient` takes one event handler, so
 *   the registry is the only subscriber on every backend and re-publishes
 *   each event with the hostId it came from. It also remembers which host
 *   owns each session, which is how pane operations find their way back.
 *   Pane ids are `pane-<uuid>`, unique across hosts; an event naming a
 *   session another host owns is dropped rather than delivered twice.
 *
 * A remote host is built from its spec in two steps (ADR-178 §1): a
 * `HostProvider` (how the box is started and reached), then a backend riding
 * the provider's transport. The registry asks the provider to bring the box
 * up before each explicit connect, and relays the keep-awake hint
 * (`updateBusy`) to it.
 */

import { createProvider } from "./providers";
import type { HostProvider } from "./providers/types";
import { RemoteBackend, classifyHostFailure } from "./remote-backend";
import type { BootstrapProgress } from "./remote-bootstrap";
import {
  LOCAL_HOST_ID,
  type GitBackend,
  type HostConnectionEvent,
  type HostFailure,
  type HostSpec,
  type StreamEvent,
  type WorkspaceBackend,
} from "./types";

export type HostStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

export interface HostStatusInfo {
  hostId: string;
  /** How the host is reached; null for the local host. */
  spec: HostSpec | null;
  status: HostStatus;
  /** Why the host is in `error`, suitable for display. */
  error?: string;
  /**
   * Set with `error` when it is a failure retrying cannot fix (bad
   * credentials, host key, no Node on the box) — see `HostFailure`.
   */
  failure?: HostFailure;
  /** Latest bootstrap progress line while `connecting`. */
  progress?: string;
  /** While `reconnecting`: the delay before the next attempt, if known. */
  retryInMs?: number | null;
  /**
   * Non-blocking issues the last successful bootstrap reported (e.g. an
   * agent config on the remote it could not safely parse). Cleared by the
   * next `connect()`; never fails the connection.
   */
  warnings?: string[];
}

type HostState = Omit<HostStatusInfo, "hostId" | "spec">;

/** A host is not in a state to serve the call; see `status`. */
export class HostUnavailableError extends Error {
  constructor(
    readonly hostId: string,
    readonly status: HostStatus | "unknown",
    detail?: string,
  ) {
    super(
      `Host "${hostId}" is ${status === "unknown" ? "not registered" : status}${
        detail ? `: ${detail}` : ""
      }`,
    );
    this.name = "HostUnavailableError";
  }
}

/** Builds a remote host's provider from its spec. */
export type HostProviderFactory = (
  hostId: string,
  spec: HostSpec,
  opts: { onBootstrapProgress: (progress: BootstrapProgress) => void },
) => HostProvider;

export type RemoteBackendFactory = (
  hostId: string,
  spec: HostSpec,
  opts: {
    version?: string;
    /** The host's provider; the backend rides `provider.transport()`. */
    provider: HostProvider;
    onBootstrapWarning: (warnings: string[]) => void;
  },
) => WorkspaceBackend;

const defaultCreateProvider: HostProviderFactory = (_hostId, spec, opts) =>
  createProvider(spec, opts);

/** A `RemoteBackend` over the provider's transport. */
const createRemoteBackend: RemoteBackendFactory = (_hostId, spec, opts) =>
  new RemoteBackend({
    target: spec.target,
    version: opts.version,
    transport: opts.provider.transport(),
    onBootstrapWarning: opts.onBootstrapWarning,
  });

export interface BackendRegistryOptions {
  /** The backend for this machine. */
  local: WorkspaceBackend;
  /** App version handed to every `connect()`. */
  version?: string;
  /** Builds a remote host's backend. Defaults to `RemoteBackend`. For tests. */
  createRemote?: RemoteBackendFactory;
  /** Builds a remote host's provider. Defaults to `createProvider`. For tests. */
  createProvider?: HostProviderFactory;
}

interface HostEntry {
  hostId: string;
  spec: HostSpec | null;
  /** Null for the local host. */
  provider: HostProvider | null;
  backend: WorkspaceBackend;
  view: WorkspaceBackend;
  state: HostState;
  connecting: Promise<void> | null;
  /**
   * Bumped by every connect attempt and every `disconnect()`. An attempt
   * only touches state while it still holds the current value, so a
   * disconnect during an in-flight connect is not overwritten by it.
   */
  attempt: number;
  /**
   * Whether a git/shell/ports call may start a background connect. Cleared
   * by an explicit `disconnect()` so a poller does not undo it.
   */
  autoConnect: boolean;
  /** The last keep-awake hint handed to the provider (see `updateBusy`). */
  busy: boolean;
}

type HostEventListener = (hostId: string, event: HostConnectionEvent) => void;
type StreamEventListener = (hostId: string, event: StreamEvent) => void;
type StatusListener = (hosts: HostStatusInfo[]) => void;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sameSpec(a: HostSpec | null, b: HostSpec | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export class BackendRegistry {
  private readonly hosts = new Map<string, HostEntry>();
  private readonly unknownViews = new Map<string, WorkspaceBackend>();
  /** Which host owns each session we have seen created, listed or streaming. */
  private readonly sessionHosts = new Map<string, string>();
  private readonly eventListeners = new Set<StreamEventListener>();
  private readonly hostEventListeners = new Set<HostEventListener>();
  private readonly statusListeners = new Set<StatusListener>();
  private readonly createRemote: RemoteBackendFactory;
  private readonly createProvider: HostProviderFactory;
  private version: string | undefined;

  constructor(opts: BackendRegistryOptions) {
    this.version = opts.version;
    this.createRemote = opts.createRemote ?? createRemoteBackend;
    this.createProvider = opts.createProvider ?? defaultCreateProvider;
    this.add(LOCAL_HOST_ID, null, null, opts.local);
  }

  // ── Hosts ──

  /**
   * The backend for `hostId`. Local: the local backend itself. Remote: a
   * gated view (see the header). Unregistered: a backend whose every call
   * fails with `HostUnavailableError`, so a project pointing at a host that
   * was removed degrades instead of throwing synchronously.
   */
  get(hostId: string): WorkspaceBackend {
    const entry = this.hosts.get(hostId);
    if (entry) return entry.view;
    let view = this.unknownViews.get(hostId);
    if (!view) {
      view = unavailableBackend(hostId);
      this.unknownViews.set(hostId, view);
    }
    return view;
  }

  has(hostId: string): boolean {
    return this.hosts.has(hostId);
  }

  /** A remote host's provider; undefined for the local host or an unknown one. */
  provider(hostId: string): HostProvider | undefined {
    return this.hosts.get(hostId)?.provider ?? undefined;
  }

  /**
   * Add a remote host. Registering the same spec again is a no-op; a
   * different spec replaces the host (the old connection is dropped).
   * Does not connect.
   */
  register(hostId: string, spec: HostSpec): void {
    if (hostId === LOCAL_HOST_ID) {
      throw new Error(`"${LOCAL_HOST_ID}" is reserved for this machine`);
    }
    const existing = this.hosts.get(hostId);
    if (existing && sameSpec(existing.spec, spec)) return;
    const provider = this.createProvider(hostId, spec, {
      onBootstrapProgress: (progress) => {
        const entry = this.hosts.get(hostId);
        if (entry?.provider !== provider || entry.state.status !== "connecting") return;
        this.setState(entry, { status: "connecting", progress: progress.message });
      },
    });
    const backend = this.createRemote(hostId, spec, {
      version: this.version,
      provider,
      onBootstrapWarning: (warnings) => {
        const entry = this.hosts.get(hostId);
        if (entry?.backend !== backend) return;
        this.setState(entry, {
          ...entry.state,
          warnings: warnings.length > 0 ? warnings : undefined,
        });
      },
    });
    this.add(hostId, spec, provider, backend);
    if (existing) {
      // Agents on the host did not stop because its spec changed.
      if (existing.busy) this.updateBusy(hostId, true);
      this.dropBackend(existing);
    }
  }

  /** Remove a remote host and drop its connection. */
  async unregister(hostId: string): Promise<void> {
    if (hostId === LOCAL_HOST_ID) {
      throw new Error(`"${LOCAL_HOST_ID}" cannot be unregistered`);
    }
    const entry = this.hosts.get(hostId);
    if (!entry) return;
    this.hosts.delete(hostId);
    this.emitStatus();
    await this.dropBackend(entry);
  }

  /** Every host and its connection status, local first. */
  list(): HostStatusInfo[] {
    return Array.from(this.hosts.values(), (entry) => ({
      hostId: entry.hostId,
      spec: entry.spec,
      ...entry.state,
    }));
  }

  status(hostId: string): HostStatus | undefined {
    return this.hosts.get(hostId)?.state.status;
  }

  /** Registered remote host ids, in registration order. */
  remoteHostIds(): string[] {
    return Array.from(this.hosts.keys()).filter((id) => id !== LOCAL_HOST_ID);
  }

  setVersion(version: string): void {
    this.version = version;
  }

  // ── Connecting ──

  /**
   * Connect `hostId` if it is not already. Concurrent callers share one
   * attempt. Rejects with the connect error, which `list()` also reports.
   * Always tries — including after `error` — so this is the retry.
   */
  async ensureConnected(hostId: string): Promise<void> {
    const entry = this.hosts.get(hostId);
    if (!entry) throw new HostUnavailableError(hostId, "unknown");
    entry.autoConnect = true;
    if (entry.state.status === "connected") return;
    if (!entry.connecting) {
      const token = ++entry.attempt;
      const attempt = this.connect(entry, token).finally(() => {
        if (entry.connecting === attempt) entry.connecting = null;
      });
      entry.connecting = attempt;
    }
    return entry.connecting;
  }

  /** `ensureConnected` without waiting; failures land in `list()`. */
  connectInBackground(hostId: string): void {
    this.ensureConnected(hostId).catch(() => {
      // Reported through status.
    });
  }

  /** Drop a remote host's connection. Its remote sessions keep running. */
  async disconnect(hostId: string): Promise<void> {
    const entry = this.hosts.get(hostId);
    if (!entry || hostId === LOCAL_HOST_ID) return;
    entry.autoConnect = false;
    entry.connecting = null;
    // Invalidate any in-flight connect so it cannot land after this.
    entry.attempt++;
    this.setState(entry, { status: "disconnected" });
    await this.disposeProvider(entry);
    await entry.backend.disconnect();
  }

  /** Drop every remote connection (app quit). */
  async disconnectAll(): Promise<void> {
    await Promise.allSettled(this.remoteHostIds().map((id) => this.disconnect(id)));
  }

  // ── Keep-awake ──

  /**
   * Whether any agent on `hostId` is working (ADR-178 §1 keep-awake rule).
   * Handed to the provider's `setBusy` only when it changes, so callers may
   * report the same value as often as they like. No-op for the local host.
   */
  updateBusy(hostId: string, busy: boolean): void {
    const entry = this.hosts.get(hostId);
    if (!entry?.provider || entry.busy === busy) return;
    entry.busy = busy;
    try {
      entry.provider.setBusy?.(busy);
    } catch (err) {
      console.warn(`[backend-registry] setBusy on ${hostId} failed:`, err);
    }
  }

  // ── Sessions ──

  /** The host a session lives on, if the registry has seen it. */
  hostForSession(sessionId: string): string | undefined {
    return this.sessionHosts.get(sessionId);
  }

  noteSession(sessionId: string, hostId: string): void {
    this.sessionHosts.set(sessionId, hostId);
  }

  forgetSession(sessionId: string): void {
    this.sessionHosts.delete(sessionId);
  }

  // ── Events ──

  /** Stream events from every host, tagged with the host they came from. */
  onEvent(handler: StreamEventListener): () => void {
    this.eventListeners.add(handler);
    return () => this.eventListeners.delete(handler);
  }

  /** Connection loss / recovery / failure on any remote host. */
  onHostEvent(handler: HostEventListener): () => void {
    this.hostEventListeners.add(handler);
    return () => this.hostEventListeners.delete(handler);
  }

  /** Called with the full `list()` whenever any host's status changes. */
  onStatusChange(handler: StatusListener): () => void {
    this.statusListeners.add(handler);
    return () => this.statusListeners.delete(handler);
  }

  // ── Internals ──

  private add(
    hostId: string,
    spec: HostSpec | null,
    provider: HostProvider | null,
    backend: WorkspaceBackend,
  ): void {
    const entry: HostEntry = {
      hostId,
      spec,
      provider,
      backend,
      view: backend,
      state: { status: "disconnected" },
      connecting: null,
      attempt: 0,
      autoConnect: true,
      busy: false,
    };
    entry.view = this.makeView(entry);
    this.hosts.set(hostId, entry);

    backend.pty.onEvent((event) => {
      if (this.hosts.get(hostId) !== entry) return;
      this.dispatchStreamEvent(hostId, event);
    });
    backend.onHostEvent((event) => {
      if (this.hosts.get(hostId) !== entry) return;
      this.handleHostEvent(entry, event);
    });
    this.emitStatus();
  }

  private async dropBackend(entry: HostEntry): Promise<void> {
    await this.disposeProvider(entry);
    try {
      await entry.backend.disconnect();
    } catch (err) {
      console.warn(`[backend-registry] disconnecting ${entry.hostId} failed:`, err);
    }
  }

  /** Release the provider's own resources (port forwards); never throws. */
  private async disposeProvider(entry: HostEntry): Promise<void> {
    try {
      await entry.provider?.dispose();
    } catch (err) {
      console.warn(`[backend-registry] disposing ${entry.hostId}'s provider failed:`, err);
    }
  }

  private async connect(entry: HostEntry, token: number): Promise<void> {
    const current = () =>
      this.hosts.get(entry.hostId) === entry && entry.attempt === token;
    // A disconnect (or replacing / removing the host) cancelled this attempt.
    const superseded = () =>
      new HostUnavailableError(
        entry.hostId,
        this.hosts.get(entry.hostId) === entry ? entry.state.status : "unknown",
        "connect was cancelled",
      );
    this.setState(entry, { status: "connecting" });
    try {
      // Start or resume the box before opening the transport to it.
      if (entry.provider) {
        await entry.provider.ensureUp();
        if (!current()) throw superseded();
      }
      await entry.backend.connect(
        this.version ? { version: this.version } : undefined,
      );
    } catch (err) {
      if (!current()) throw superseded();
      const failure = classifyHostFailure(err);
      this.setState(entry, {
        status: "error",
        error: failure?.message ?? errorMessage(err),
        ...(failure ? { failure } : {}),
      });
      throw err;
    }
    // Resolving now would hand a pty call a client that was disposed.
    if (!current()) throw superseded();
    // A bootstrap warning may have landed on `entry.state` while this attempt
    // was still "connecting" (see `onBootstrapWarning` above) — carry it
    // forward rather than letting this transition drop it.
    this.setState(entry, {
      status: "connected",
      ...(entry.state.warnings ? { warnings: entry.state.warnings } : {}),
    });
  }

  private handleHostEvent(entry: HostEntry, event: HostConnectionEvent): void {
    for (const sessionId of event.sessionIds) {
      this.sessionHosts.set(sessionId, entry.hostId);
    }
    switch (event.type) {
      // Auto-reconnect doesn't rerun bootstrap, so nothing would re-report
      // its warnings — carry them across the blip (connected → reconnecting →
      // connected), as `connect()` does across "connecting".
      case "hostDisconnected":
        this.setState(entry, {
          status: "reconnecting",
          retryInMs: event.retryInMs,
          ...(entry.state.warnings ? { warnings: entry.state.warnings } : {}),
        });
        break;
      case "hostReconnected":
        this.setState(entry, {
          status: "connected",
          ...(entry.state.warnings ? { warnings: entry.state.warnings } : {}),
        });
        break;
      case "hostFailed": {
        const failure: HostFailure = {
          reason: event.reason,
          message: event.message,
          ...(event.code !== undefined ? { code: event.code } : {}),
        };
        this.setState(entry, { status: "error", error: event.message, failure });
        break;
      }
    }
    for (const listener of this.hostEventListeners) {
      try {
        listener(entry.hostId, event);
      } catch (err) {
        console.error("[backend-registry] host event listener threw:", err);
      }
    }
  }

  private dispatchStreamEvent(hostId: string, event: StreamEvent): void {
    if ("sessionId" in event) {
      const owner = this.sessionHosts.get(event.sessionId);
      if (owner !== undefined && owner !== hostId) {
        console.warn(
          `[backend-registry] dropping ${event.type} for ${event.sessionId} from ${hostId}; it belongs to ${owner}`,
        );
        return;
      }
      if (event.type === "exit") this.sessionHosts.delete(event.sessionId);
      else if (owner === undefined) this.sessionHosts.set(event.sessionId, hostId);
    }
    for (const listener of this.eventListeners) {
      try {
        listener(hostId, event);
      } catch (err) {
        console.error("[backend-registry] stream event listener threw:", err);
      }
    }
  }

  private setState(entry: HostEntry, state: HostState): void {
    if (JSON.stringify(entry.state) === JSON.stringify(state)) return;
    entry.state = state;
    if (this.hosts.get(entry.hostId) === entry) this.emitStatus();
  }

  private emitStatus(): void {
    if (this.statusListeners.size === 0) return;
    const hosts = this.list();
    for (const listener of this.statusListeners) {
      try {
        listener(hosts);
      } catch (err) {
        console.error("[backend-registry] status listener threw:", err);
      }
    }
  }

  /** Wait for the connection (connecting it if need be) before a pty call. */
  private async ptyGate(entry: HostEntry): Promise<void> {
    if (this.hosts.get(entry.hostId) !== entry) {
      throw new HostUnavailableError(entry.hostId, "unknown");
    }
    switch (entry.state.status) {
      case "connected":
        return;
      case "reconnecting":
        // The client is already retrying; let it decide what to do with the call.
        return;
      case "error":
        throw new HostUnavailableError(entry.hostId, "error", entry.state.error);
      case "disconnected":
      case "connecting":
        await this.ensureConnected(entry.hostId);
    }
  }

  /**
   * Fail fast unless connected, before a git / shell / ports call. Those
   * are what pollers make, and a poller must not wait out an ssh handshake.
   */
  private async execGate(entry: HostEntry): Promise<void> {
    if (this.hosts.get(entry.hostId) !== entry) {
      throw new HostUnavailableError(entry.hostId, "unknown");
    }
    const { status, error } = entry.state;
    if (status === "connected") return;
    if (status === "disconnected" && entry.autoConnect) {
      this.connectInBackground(entry.hostId);
    }
    throw new HostUnavailableError(entry.hostId, status, error);
  }

  private makeView(entry: HostEntry): WorkspaceBackend {
    const { hostId, backend } = entry;
    const isLocal = hostId === LOCAL_HOST_ID;
    const ptyGate = isLocal ? null : () => this.ptyGate(entry);
    const execGate = isLocal ? null : () => this.execGate(entry);
    return {
      pty: gated(backend.pty, ptyGate, {
        // Fire-and-forget: nothing to await, and the client drops writes
        // for a session it is not connected to.
        write: null,
        relayAgentHook: null,
        // The registry is the backend's one subscriber (the client keeps a
        // single handler); per-host subscribers go through it.
        onEvent: (handler: (event: StreamEvent) => void) => {
          this.onEvent((from, event) => {
            if (from === hostId) handler(event);
          });
        },
      }),
      git: gated(backend.git, execGate, {
        pushStream: execGate
          ? deferredPushStream(backend.git, execGate)
          : null,
      }),
      shell: gated(backend.shell, execGate, {}),
      ports: gated(backend.ports, execGate, {}),
      connect: () => this.ensureConnected(hostId),
      disconnect: () => this.disconnect(hostId),
      onHostEvent: (handler) => {
        this.onHostEvent((from, event) => {
          if (from === hostId) handler(event);
        });
      },
    };
  }
}

/**
 * Wrap every method of `target` so it awaits `gate` first. `overrides` maps
 * a method to a replacement, or to null to call it straight through. A null
 * gate calls everything straight through (the local host).
 */
function gated<T extends object>(
  target: T,
  gate: (() => Promise<void>) | null,
  overrides: Record<string, unknown>,
): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      if (typeof prop === "string" && prop in overrides) {
        const override = overrides[prop];
        if (override !== null) return override;
      }
      const value: unknown = Reflect.get(obj, prop, receiver);
      if (typeof value !== "function") return value;
      const fn = value as (...args: unknown[]) => unknown;
      if (!gate || (typeof prop === "string" && prop in overrides)) {
        return (...args: unknown[]) => fn.apply(obj, args);
      }
      return async (...args: unknown[]) => {
        await gate();
        return fn.apply(obj, args);
      };
    },
  });
}

/** `pushStream` is synchronous, so the gate runs before the push starts. */
function deferredPushStream(
  git: GitBackend,
  gate: () => Promise<void>,
): GitBackend["pushStream"] {
  return (cwd, opts, callbacks) => {
    let cancelled = false;
    let inner: { cancel: () => void } | null = null;
    gate().then(
      () => {
        if (cancelled) {
          callbacks.onDone({ exitCode: null, stderr: "" });
          return;
        }
        inner = git.pushStream(cwd, opts, callbacks);
      },
      (err: unknown) => {
        callbacks.onDone({ exitCode: null, stderr: errorMessage(err) });
      },
    );
    return {
      cancel: () => {
        cancelled = true;
        inner?.cancel();
      },
    };
  };
}

/** The backend of a host nobody registered: every call fails. */
function unavailableBackend(hostId: string): WorkspaceBackend {
  const fail = async (): Promise<never> => {
    throw new HostUnavailableError(hostId, "unknown");
  };
  const failing = <T extends object>(overrides: Record<string, unknown>): T =>
    new Proxy({} as T, {
      get(_obj, prop) {
        if (typeof prop === "string" && prop in overrides) return overrides[prop];
        // Not thenable: a Proxy answering `then` would look like a promise.
        if (prop === "then") return undefined;
        return fail;
      },
    });
  return {
    pty: failing({ write: () => {}, relayAgentHook: () => {}, onEvent: () => {} }),
    git: failing({
      pushStream: (
        _cwd: string,
        _opts: unknown,
        callbacks: Parameters<GitBackend["pushStream"]>[2],
      ) => {
        callbacks.onDone({
          exitCode: null,
          stderr: new HostUnavailableError(hostId, "unknown").message,
        });
        return { cancel: () => {} };
      },
    }),
    shell: failing({}),
    ports: failing({}),
    connect: fail,
    disconnect: async () => {},
    onHostEvent: () => {},
  };
}
