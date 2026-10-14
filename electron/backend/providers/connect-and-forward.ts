/**
 * What the ssh and command providers share: the outcome of their last
 * connect, and the checks on a port forward's ports.
 */

import { errorMessage } from "../../lib/errors";
import type { EnsureRemoteHost } from "../../terminal-host/bridge-spawner";
import type { ProviderStatus } from "./types";

/** The box's loopback a forward may target; nothing past it. */
export type RemoteLoopback = "127.0.0.1" | "::1";

export function assertPort(port: number, label: string): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid ${label} port: ${port}`);
  }
}

/** `preferred` when it is a valid port none of `held`'s forwards uses, else null. */
export function preferredLocalPort(
  preferred: number | undefined,
  held: ReadonlyMap<number, unknown>,
): number | null {
  return preferred !== undefined &&
    Number.isInteger(preferred) &&
    preferred > 0 &&
    preferred <= 65535 &&
    !held.has(preferred)
    ? preferred
    : null;
}

/** A provider's last connect: `up` until a run of the host ensurer fails. */
export class ConnectOutcome {
  private last: ProviderStatus = { state: "up" };

  status(): ProviderStatus {
    return { ...this.last };
  }

  /** `ensure`, recording each run's outcome. */
  track(ensure: EnsureRemoteHost): EnsureRemoteHost {
    return async (...args) => {
      try {
        await ensure(...args);
        this.last = { state: "up" };
      } catch (err) {
        this.last = { state: "unreachable", detail: errorMessage(err) };
        throw err;
      }
    };
  }
}
