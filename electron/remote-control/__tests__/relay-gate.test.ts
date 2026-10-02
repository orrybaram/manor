/**
 * The relay's hello gate (ADR-206 D5, ADR-207 D3): verify, backoff, road and
 * tier, in that order. Against a fake verifier and a fake bridge, so the test
 * is about the decisions; `ws-bridge.test.ts` and the connector's tests run
 * the same gate in front of the real bridge transport.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

import { AuthRateLimiter } from "../rate-limit";
import { RelayGate, type AuthenticatedDevice } from "../relay-gate";
import type { BridgeAuthenticator } from "../../bridge/transports/ws";
import type { FrameSocket } from "../../bridge/transports/frame-socket";

const RELAY_TOKEN = "relay-token";
const RELAY_SEND_TOKEN = "relay-send-token";
const TAILSCALE_TOKEN = "tailscale-token";
const LEGACY_TOKEN = "legacy-token";

const relayed: AuthenticatedDevice = {
  id: "dev-relay",
  label: "relay browser",
  capability: "full",
  via: "relay",
};
const relayedSend: AuthenticatedDevice = {
  id: "dev-relay-send",
  label: "relay phone",
  capability: "send",
  via: "relay",
};
const tailscale: AuthenticatedDevice = {
  id: "dev-ts",
  label: "laptop browser",
  capability: "full",
  via: "tailscale",
};
/** Paired before `via` existed: reads as Tailscale. */
const legacy: AuthenticatedDevice = {
  id: "dev-legacy",
  label: "old browser",
  capability: "full",
};

const devices = {
  verify: (raw: unknown) => {
    if (raw === RELAY_TOKEN) return relayed;
    if (raw === RELAY_SEND_TOKEN) return relayedSend;
    if (raw === TAILSCALE_TOKEN) return tailscale;
    if (raw === LEGACY_TOKEN) return legacy;
    return null;
  },
};

const UNAUTHORIZED = { ok: false, code: 4401 };

describe("RelayGate", () => {
  let now: number;
  let limiter: AuthRateLimiter;
  let bridge: {
    attach: ReturnType<
      typeof vi.fn<(socket: FrameSocket, auth: BridgeAuthenticator) => void>
    >;
    closeDevice: ReturnType<typeof vi.fn<(deviceId: string) => void>>;
    closeAll: ReturnType<typeof vi.fn<() => void>>;
  };
  let gate: RelayGate;

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    now = 1_000_000;
    limiter = new AuthRateLimiter(() => now);
    bridge = {
      attach: vi.fn<(socket: FrameSocket, auth: BridgeAuthenticator) => void>(),
      closeDevice: vi.fn<(deviceId: string) => void>(),
      closeAll: vi.fn<() => void>(),
    };
    gate = new RelayGate(devices, bridge, limiter);
  });

  describe("the hello", () => {
    it("admits a full device paired through the relay", () => {
      expect(gate.authenticate(RELAY_TOKEN)).toEqual({
        ok: true,
        device: relayed,
      });
    });

    it("refuses a Tailscale-paired full token exactly as an unknown one", () => {
      // The tailnet is that token's first factor; the relay must not remove it.
      expect(gate.authenticate(TAILSCALE_TOKEN)).toEqual(UNAUTHORIZED);
      expect(limiter.failureCount("relay")).toBe(1);
    });

    it("reads a device with no road as Tailscale", () => {
      expect(gate.authenticate(LEGACY_TOKEN)).toEqual(UNAUTHORIZED);
    });

    it("closes a relay device below full with 4403, not 4401", () => {
      // The token is real: 4403 is what tells the browser to re-pair at
      // `full` rather than that its token is dead.
      expect(gate.authenticate(RELAY_SEND_TOKEN)).toEqual({
        ok: false,
        code: 4403,
      });
      expect(limiter.failureCount("relay")).toBe(0);
    });

    it("refuses a wrong token, and a hello with no token at all", () => {
      expect(gate.authenticate("nope")).toEqual(UNAUTHORIZED);
      now += 1_000;
      expect(gate.authenticate(undefined)).toEqual(UNAUTHORIZED);
      expect(limiter.failureCount("relay")).toBe(2);
    });
  });

  describe("failed-auth backoff", () => {
    it("does not count another failure while the source is backed off", () => {
      expect(gate.authenticate("nope")).toEqual(UNAUTHORIZED);
      expect(limiter.retryAfterMs("relay")).toBe(1_000);
      expect(gate.authenticate("nope-again")).toEqual(UNAUTHORIZED);
      expect(limiter.failureCount("relay")).toBe(1);

      now += 1_000;
      expect(gate.authenticate("nope-again")).toEqual(UNAUTHORIZED);
      expect(limiter.failureCount("relay")).toBe(2);
    });

    // The reason verification runs before the backoff check. Every relay
    // viewer shares one source: a stranger guessing tokens against the room
    // and the owner's phone land in the same bucket. If the backoff could
    // reject an authenticated hello, the guesser would be locking the owner
    // out of their own machine.
    it("admits a valid token while the shared source is backed off", () => {
      for (let i = 0; i < 5; i++) {
        gate.authenticate(`guess-${i}`);
        now += 60_000;
      }
      gate.authenticate("one-more");
      expect(limiter.retryAfterMs("relay")).toBeGreaterThan(0);
      expect(gate.authenticate(RELAY_TOKEN)).toMatchObject({ ok: true });
    });

    it("clears the backoff after a success", () => {
      gate.authenticate("nope");
      expect(gate.authenticate(RELAY_TOKEN)).toMatchObject({ ok: true });
      expect(limiter.retryAfterMs("relay")).toBe(0);
      // The next failure starts at 1s again rather than resuming the doubling.
      gate.authenticate("nope");
      expect(limiter.retryAfterMs("relay")).toBe(1_000);
    });
  });

  describe("the bridge behind it", () => {
    it("attaches a channel with this gate as its authenticator", () => {
      const socket = {} as FrameSocket;
      gate.attach(socket);
      expect(bridge.attach).toHaveBeenCalledTimes(1);
      const [attached, authenticate] = bridge.attach.mock.calls[0];
      expect(attached).toBe(socket);
      expect(authenticate(RELAY_TOKEN)).toEqual({ ok: true, device: relayed });
      expect(authenticate(TAILSCALE_TOKEN)).toEqual(UNAUTHORIZED);
    });

    it("closes a revoked device's connections", () => {
      gate.closeDevice("dev-relay");
      expect(bridge.closeDevice).toHaveBeenCalledWith("dev-relay");
    });

    it("closes every connection, and stops sweeping, when closed", () => {
      const stop = vi.spyOn(limiter, "stop");
      gate.open();
      gate.close();
      expect(bridge.closeAll).toHaveBeenCalledTimes(1);
      expect(stop).toHaveBeenCalledTimes(1);
    });
  });
});
