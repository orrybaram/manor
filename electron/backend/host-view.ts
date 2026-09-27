/**
 * What `BackendRegistry.get(hostId)` hands out (ADR-160 §6, ADR-183).
 *
 * A remote host's view is gated: it waits for the connection before a pty
 * call, and fails fast — kicking off a background connect — before a git,
 * shell or ports call. Pollers therefore never sit on a host that is not
 * there, and one unreachable host cannot stall the others. The local view is
 * ungated and calls every method straight through, so a local-only setup
 * behaves exactly as before. Either way `connect`/`disconnect` go through the
 * host's `HostConnection`, so its status stays right.
 *
 * A host nobody registered gets `unavailableBackend`, whose every call fails.
 */

import { errorMessage } from "../lib/errors";
import { streamAfter, type StreamResult } from "./exec";
import type { HostConnection, HostStatus } from "./host-connection";
import { posixJoin } from "./machine-facts";
import type { GitBackend, WorkspaceBackend } from "./types";

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

export interface HostGates {
  /** Awaited before a pty call. */
  pty: () => Promise<void>;
  /**
   * What a failed pty call (its gate included) rejects with: a
   * `HostUnavailableError` whenever the host is not connected, so callers
   * can tell "the host is away" from a broken terminal by type alone
   * (ADR-183).
   */
  ptyFailure: (err: unknown) => unknown;
  /** Awaited before a git / shell / ports call. */
  exec: () => Promise<void>;
}

/** A remote host's gates. */
export function hostGates(conn: HostConnection): HostGates {
  return {
    // Wait for the connection (connecting it if need be).
    pty: async () => {
      if (conn.disposed) throw new HostUnavailableError(conn.hostId, "unknown");
      switch (conn.status) {
        case "connected":
          return;
        case "reconnecting":
          // The client is already retrying; let it decide what to do with the call.
          return;
        case "error":
          throw new HostUnavailableError(conn.hostId, "error", conn.error);
        case "disconnected":
        case "connecting":
          await conn.ensureConnected();
      }
    },
    ptyFailure: (err) => {
      if (err instanceof HostUnavailableError) return err;
      if (conn.disposed) return new HostUnavailableError(conn.hostId, "unknown", errorMessage(err));
      if (conn.status === "connected") return err;
      return new HostUnavailableError(conn.hostId, conn.status, errorMessage(err));
    },
    // Fail fast unless connected. Git, shell and ports calls are what
    // pollers make, and a poller must not wait out an ssh handshake.
    exec: async () => {
      if (conn.disposed) throw new HostUnavailableError(conn.hostId, "unknown");
      const { status, error } = conn;
      if (status === "connected") return;
      if (status === "disconnected" && conn.autoConnect) conn.connectInBackground();
      throw new HostUnavailableError(conn.hostId, status, error);
    },
  };
}

/** `conn`'s backend behind `gates`; straight through when there are none. */
export function hostView(conn: HostConnection, gates: HostGates | null): WorkspaceBackend {
  const { backend } = conn;
  const exec = gates?.exec ?? null;
  return {
    // Every other pty call waits for the connection — `getPaneFacts`
    // included, since main asks for it to resync once a host is back (ADR-184).
    pty: gated(
      backend.pty,
      gates?.pty ?? null,
      {
        // Fire-and-forget: nothing to await, and the client drops writes
        // for a session it is not connected to.
        write: null,
        onEvent: null,
      },
      gates?.ptyFailure,
    ),
    git: gated(backend.git, exec, {
      pushStream: exec ? deferredStream(backend.git, "pushStream", exec) : null,
      cloneStream: exec ? deferredStream(backend.git, "cloneStream", exec) : null,
    }),
    shell: gated(backend.shell, exec, {}),
    ports: gated(backend.ports, exec, {}),
    // Facts are asked through the host's exec, so they share its gate —
    // except `join`, which is synchronous and asks nothing.
    facts: gated(backend.facts, exec, { join: null }),
    connect: () => conn.ensureConnected(),
    disconnect: () => conn.disconnect(),
  };
}

/**
 * Wrap every method of `target` so it awaits `gate` first. `overrides` maps
 * a method to a replacement, or to null to call it straight through. A null
 * gate calls everything straight through (the local host). A gated call
 * that fails rejects with `failure(err)`, when given.
 */
function gated<T extends object>(
  target: T,
  gate: (() => Promise<void>) | null,
  overrides: Record<string, unknown>,
  failure?: (err: unknown) => unknown,
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
        try {
          await gate();
          return await fn.apply(obj, args);
        } catch (err) {
          throw failure ? failure(err) : err;
        }
      };
    },
  });
}

type StreamMethod = "pushStream" | "cloneStream";

/**
 * A git stream method is synchronous (it returns its cancel handle at once),
 * so the gate runs before the stream starts rather than in front of the call.
 */
function deferredStream<K extends StreamMethod>(
  git: GitBackend,
  method: K,
  gate: () => Promise<void>,
): GitBackend[K] {
  return ((...args: unknown[]) => {
    // Both methods take their callbacks last.
    const callbacks = args[args.length - 1] as {
      onLine: (line: string) => void;
      onDone: (result: StreamResult) => void;
    };
    return streamAfter(
      gate(),
      (_ready, done) => {
        const start = git[method] as (...a: unknown[]) => { cancel: () => void };
        return start.call(git, ...args.slice(0, -1), { ...callbacks, onDone: done });
      },
      callbacks.onDone,
    );
  }) as GitBackend[K];
}

/** The backend of a host nobody registered: every call fails. */
export function unavailableBackend(hostId: string): WorkspaceBackend {
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
  // Both stream methods take their callbacks last.
  const failStream = (...args: unknown[]) => {
    const { onDone } = args[args.length - 1] as { onDone: (result: StreamResult) => void };
    onDone({ exitCode: null, stderr: new HostUnavailableError(hostId, "unknown").message });
    return { cancel: () => {} };
  };
  return {
    pty: failing({ write: () => {}, onEvent: () => () => {} }),
    git: failing({ pushStream: failStream, cloneStream: failStream }),
    shell: failing({}),
    ports: failing({}),
    // Every remote host is POSIX (a Linux or macOS box), and joining a path
    // asks the host nothing.
    facts: failing({ join: posixJoin }),
    connect: fail,
    disconnect: async () => {},
  };
}
