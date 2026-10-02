/**
 * The relay's hello gate (ADR-206 D5, ADR-207 D3).
 *
 * Remote control opens no listening socket: the only way in is a Noise
 * channel through the relay, handed to the bridge like any other
 * `FrameSocket`. What that channel's `hello` has to get past lives here —
 * the device verify, the failed-auth backoff and the tier check — along with
 * the one thing a revoke needs afterwards, closing a device's live channels.
 *
 * **Verify first, backoff second.** Every relay viewer shares one `relay`
 * source (`rate-limit.ts`), so a backoff someone else earned must never be
 * able to close a channel holding a valid token. A token is checked before
 * the backoff is consulted, and only a hello that failed is penalised.
 *
 * **Only a device paired through the relay gets in.** A token minted for a
 * Tailscale pairing was handed out on the understanding that the tailnet is
 * a first factor in front of it; such a token is treated exactly as an
 * unknown one — 4401, and a failure for the backoff — so the relay is not an
 * oracle for which of those tokens are real.
 *
 * The tier check comes last and is a *different* answer: 4403 says the token
 * is real and this device is not allowed here, which is what lets the
 * pairing UI tell the user to re-pair at `full` instead of guessing.
 */

import type { Capability, PairedVia } from "./devices";
import { AuthRateLimiter } from "./rate-limit";
import type { BridgeAuthResult, WsBridgeServer } from "../bridge/transports/ws";
import type { FrameSocket } from "../bridge/transports/frame-socket";
import { CLOSE_FORBIDDEN, CLOSE_UNAUTHORIZED } from "../bridge/types";

/** What the gate needs of a device. `RemoteDeviceStore` satisfies it. */
export interface AuthenticatedDevice {
  id: string;
  label: string;
  capability: Capability;
  /**
   * Which road the device was paired through. Absent reads as `tailscale`:
   * the gate admits only devices that say `relay`.
   */
  via?: PairedVia;
}

interface DeviceVerifier {
  verify(rawToken: unknown): AuthenticatedDevice | null;
}

/** Every relay viewer's backoff bucket: the relay hides who a viewer is. */
const RELAY_SOURCE = "relay";

export class RelayGate {
  private readonly limiter: AuthRateLimiter;

  /**
   * @param bridge The bridge transport every admitted channel is attached
   *   to, and whose live connections `closeDevice` and `close` reach.
   */
  constructor(
    private readonly devices: DeviceVerifier,
    private readonly bridge: Pick<
      WsBridgeServer,
      "attach" | "closeDevice" | "closeAll"
    >,
    limiter: AuthRateLimiter = new AuthRateLimiter(),
  ) {
    this.limiter = limiter;
  }

  /** Remote control is on: sweep the backoff map while it is. */
  open(): void {
    this.limiter.start();
  }

  /**
   * Remote control is off: close every attached connection and stop
   * sweeping. The relay is stopped first, by the controller, so nothing new
   * arrives while this runs.
   */
  close(): void {
    this.bridge.closeAll();
    this.limiter.stop();
  }

  /** Hand a finished relay channel to the bridge, behind this gate's hello check. */
  attach(socket: FrameSocket): void {
    this.bridge.attach(socket, (token) => this.authenticate(token));
  }

  /**
   * Close every live connection a device holds, with 4401. Auth happens once
   * per connection, at hello, so revoking a device only stops new ones.
   */
  closeDevice(deviceId: string): void {
    this.bridge.closeDevice(deviceId);
  }

  /** Verify a `hello`: token, then backoff, then road, then tier. */
  authenticate(token: unknown): BridgeAuthResult {
    const verified = token === undefined ? null : this.devices.verify(token);
    const device =
      verified && (verified.via ?? "tailscale") === "relay" ? verified : null;
    if (!device) {
      if (this.limiter.retryAfterMs(RELAY_SOURCE) > 0) {
        return { ok: false, code: CLOSE_UNAUTHORIZED };
      }
      const delay = this.limiter.recordFailure(RELAY_SOURCE);
      // Loud on purpose: a knock is worth seeing. The presented token is
      // never logged, in any form.
      console.warn(
        `[remote-control] rejected relay hello ` +
          `(${this.limiter.failureCount(RELAY_SOURCE)} consecutive, backing off ${delay}ms)`,
      );
      return { ok: false, code: CLOSE_UNAUTHORIZED };
    }
    this.limiter.recordSuccess(RELAY_SOURCE);
    if (device.capability !== "full") {
      return { ok: false, code: CLOSE_FORBIDDEN };
    }
    return { ok: true, device };
  }
}
