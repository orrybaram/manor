/**
 * Push is the part of ADR-161 that reaches a locked screen, so these tests are
 * mostly about restraint: exactly one push per subscribed device, nothing at
 * all for a revoked one, no scrollback in the payload, and a dead endpoint
 * dropped rather than retried forever.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const keychain = vi.hoisted(() => ({ available: true }));

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => keychain.available,
    encryptString: (s: string) => Buffer.from(`enc:${s}`, "utf8"),
    decryptString: (b: Buffer) => b.toString("utf8").replace(/^enc:/, ""),
  },
}));

import { RemoteDeviceStore } from "../devices";
import { PushManager, isPushable, pushPayloadFor } from "../push";

const SUBSCRIPTION = {
  endpoint: "https://push.example/abc",
  keys: { p256dh: "p256dh-value", auth: "auth-value" },
};

const AGENT = {
  id: "agent-1",
  name: "fix the thing",
  projectName: "manor",
};

describe("PushManager", () => {
  let dir: string;
  let devices: RemoteDeviceStore;
  let send: ReturnType<typeof vi.fn>;
  let push: PushManager;

  beforeEach(() => {
    keychain.available = true;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "manor-push-"));
    devices = new RemoteDeviceStore(path.join(dir, "devices.enc"));
    send = vi.fn(async () => ({}));
    push = new PushManager(
      devices,
      path.join(dir, "vapid.enc"),
      send as never,
      () => ({ publicKey: "pub-key", privateKey: "priv-key" }),
    );
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function pairedWithPush(label = "phone") {
    const { device } = devices.pair(label, false);
    push.subscribe(device.id, SUBSCRIPTION);
    return device;
  }

  it("generates a key pair once and reuses it", () => {
    const generate = vi.fn(() => ({
      publicKey: "pub-key",
      privateKey: "priv-key",
    }));
    const p = new PushManager(
      devices,
      path.join(dir, "vapid.enc"),
      send as never,
      generate,
    );
    expect(p.publicKey()).toBe("pub-key");
    expect(p.publicKey()).toBe("pub-key");
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("persists the key pair 0600 and reloads it", () => {
    const file = path.join(dir, "vapid.enc");
    expect(push.publicKey()).toBe("pub-key");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);

    const reopened = new PushManager(devices, file, send as never, () => {
      throw new Error("must not regenerate");
    });
    expect(reopened.publicKey()).toBe("pub-key");
  });

  it("refuses to store a key it cannot encrypt", () => {
    keychain.available = false;
    const p = new PushManager(
      devices,
      path.join(dir, "vapid-2.enc"),
      send as never,
      () => ({ publicKey: "pub-key", privateKey: "priv-key" }),
    );
    expect(p.publicKey()).toBeNull();
    expect(fs.existsSync(path.join(dir, "vapid-2.enc"))).toBe(false);
  });

  it("sends exactly one push per subscribed device", async () => {
    pairedWithPush("phone");
    pairedWithPush("tablet");
    expect(await push.notify(pushPayloadFor("requires_input", AGENT))).toBe(2);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("sends nothing to a device that never subscribed", async () => {
    devices.pair("silent", false);
    expect(await push.notify(pushPayloadFor("requires_input", AGENT))).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("sends nothing to a revoked device", async () => {
    const device = pairedWithPush();
    devices.revoke(device.id);
    expect(await push.notify(pushPayloadFor("error", AGENT))).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses to attach a subscription to an unknown device", () => {
    expect(push.subscribe("no-such-device", SUBSCRIPTION)).toBe(false);
  });

  it("drops an endpoint the push service has retired", async () => {
    pairedWithPush();
    send.mockRejectedValueOnce(
      Object.assign(new Error("gone"), { statusCode: 410 }),
    );
    expect(await push.notify(pushPayloadFor("requires_input", AGENT))).toBe(0);
    expect(devices.pushTargets()).toEqual([]);

    // The next transition must not retry the dead endpoint.
    send.mockClear();
    await push.notify(pushPayloadFor("requires_input", AGENT));
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps a subscription that failed for a transient reason", async () => {
    pairedWithPush();
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    send.mockRejectedValueOnce(
      Object.assign(new Error("boom"), { statusCode: 500 }),
    );
    expect(await push.notify(pushPayloadFor("requires_input", AGENT))).toBe(0);
    expect(devices.pushTargets()).toHaveLength(1);
    spy.mockRestore();
  });

  it("sends no push at all when the key cannot be stored", async () => {
    pairedWithPush();
    keychain.available = false;
    const p = new PushManager(
      devices,
      path.join(dir, "vapid-3.enc"),
      send as never,
      () => ({ publicKey: "pub-key", privateKey: "priv-key" }),
    );
    expect(await p.notify(pushPayloadFor("requires_input", AGENT))).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("carries the session and project, and nothing else", async () => {
    pairedWithPush();
    await push.notify(pushPayloadFor("requires_input", AGENT));
    const payload = JSON.parse(send.mock.calls[0][1] as string) as Record<
      string,
      unknown
    >;
    expect(payload).toEqual({
      agentId: "agent-1",
      title: "Agent needs input",
      body: "fix the thing — manor",
    });
  });

  it("hands out only the public half of the pair", () => {
    // `publicKey()` is what reaches the phone via `GET /me`; the private key
    // never leaves this module, and on disk it is safeStorage-encrypted at
    // 0600 (asserted above).
    expect(push.publicKey()).toBe("pub-key");
  });
});

describe("isPushable", () => {
  it("is true only for the two statuses worth waking a phone for", () => {
    expect(isPushable("requires_input")).toBe(true);
    expect(isPushable("error")).toBe(true);
    for (const status of [
      "working",
      "thinking",
      "idle",
      "complete",
      "responded",
    ])
      expect(isPushable(status)).toBe(false);
  });
});

describe("pushPayloadFor", () => {
  it("titles an error differently from a block", () => {
    expect(pushPayloadFor("error", AGENT).title).toBe("Agent errored");
    expect(pushPayloadFor("requires_input", AGENT).title).toBe(
      "Agent needs input",
    );
  });

  it("falls back to a generic name", () => {
    expect(
      pushPayloadFor("error", { id: "t", name: null, projectName: null }).body,
    ).toBe("Agent");
  });
});
