import { SELF, env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { base64urlDecode } from "../../src/lib/relay-crypto";
import { OP_DATA, OP_OPEN } from "../../src/lib/relay-crypto/protocol";
import { DEV_PAYLOAD_LOG_PREFIX, devPayloadLogEnabled } from "../src/room";
import {
  TestSocket,
  authMessage,
  frame,
  freshIp,
  newIdentity,
} from "./helpers";

/**
 * The dev payload log (`room.ts`) exists so the relay e2e can prove the room
 * is blind. It must never be on unless both gates hold: the var that only
 * `wrangler dev --var` sets, and a request addressed to loopback.
 */

describe("devPayloadLogEnabled", () => {
  it("is on only with the var set to 1 and a loopback request", () => {
    const on = { RELAY_DEV_PAYLOAD_LOG: "1" };
    expect(devPayloadLogEnabled(on, "http://127.0.0.1:8787/join/x")).toBe(true);
    expect(devPayloadLogEnabled(on, "http://localhost:8787/host/x")).toBe(true);
    expect(devPayloadLogEnabled(on, "http://[::1]:8787/join/x")).toBe(true);

    // The deployed shape: a real hostname, whatever the var says.
    expect(devPayloadLogEnabled(on, "https://relay.example.com/join/x")).toBe(
      false,
    );
    expect(devPayloadLogEnabled(on, "https://127.0.0.1.example.com/")).toBe(
      false,
    );
    expect(devPayloadLogEnabled(on, "not a url")).toBe(false);

    // Loopback, but the var is unset or not exactly "1".
    for (const value of [undefined, "", "0", "true", "yes", " 1"]) {
      expect(
        devPayloadLogEnabled(
          { RELAY_DEV_PAYLOAD_LOG: value },
          "http://127.0.0.1:8787/join/x",
        ),
        String(value),
      ).toBe(false);
    }
  });

  it("is not set by wrangler.toml", () => {
    expect(env.RELAY_DEV_PAYLOAD_LOG).toBeUndefined();
  });
});

describe("the dev payload log, end to end in the room", () => {
  const mutableEnv = env as { RELAY_DEV_PAYLOAD_LOG?: string };

  afterEach(() => {
    delete mutableEnv.RELAY_DEV_PAYLOAD_LOG;
    vi.restoreAllMocks();
  });

  /** Like `helpers.ts`'s `connect`, at a chosen origin. */
  async function connectAt(
    origin: string,
    path: string,
    headers: Record<string, string> = {},
  ): Promise<TestSocket> {
    const res = await SELF.fetch(`${origin}${path}`, {
      headers: { Upgrade: "websocket", ...headers },
    });
    if (res.status !== 101 || !res.webSocket) {
      throw new Error(`expected 101, got ${res.status}`);
    }
    return new TestSocket(res.webSocket, path.startsWith("/host/"));
  }

  /**
   * A host and a viewer at `origin` swap one payload each way. Returns the
   * dev payload log lines the room printed meanwhile.
   */
  async function exchange(origin: string): Promise<string[]> {
    const log = vi.spyOn(console, "log");
    const { identity, roomId } = newIdentity();

    const host = await connectAt(origin, `/host/${roomId}`, {
      "CF-Connecting-IP": freshIp(),
    });
    const challenge = await host.nextJson();
    host.send(
      authMessage(identity, roomId, base64urlDecode(String(challenge.c))),
    );
    expect(await host.nextJson()).toEqual({ t: "ok" });

    const viewer = await connectAt(origin, `/join/${roomId}`, {
      "CF-Connecting-IP": freshIp(),
    });
    expect(await host.nextBytes()).toEqual(frame(OP_OPEN, 1));

    viewer.send(new Uint8Array([1, 2, 3]));
    expect(await host.nextBytes()).toEqual(frame(OP_DATA, 1, [1, 2, 3]));
    host.send(frame(OP_DATA, 1, [4, 5, 6]));
    expect(await viewer.nextBytes()).toEqual(new Uint8Array([4, 5, 6]));

    viewer.close();
    host.close();
    return log.mock.calls
      .map((args) => args.map(String).join(" "))
      .filter((line) => line.startsWith(DEV_PAYLOAD_LOG_PREFIX));
  }

  it("is off by default, even for a loopback exchange", async () => {
    expect(await exchange("http://127.0.0.1:8787")).toEqual([]);
  });

  it("is off with the var set when the request is not addressed to loopback", async () => {
    mutableEnv.RELAY_DEV_PAYLOAD_LOG = "1";
    expect(await exchange("https://relay.test")).toEqual([]);
  });

  // The control: without it, the two above would pass for a log that
  // never worked at all — and so would the e2e's blindness check.
  it("logs every forwarded payload, base64url, with both gates open", async () => {
    mutableEnv.RELAY_DEV_PAYLOAD_LOG = "1";
    expect(await exchange("http://127.0.0.1:8787")).toEqual([
      `${DEV_PAYLOAD_LOG_PREFIX} viewer->host ch=1 AQID`,
      `${DEV_PAYLOAD_LOG_PREFIX} host->viewer ch=1 BAUG`,
    ]);
  });
});
