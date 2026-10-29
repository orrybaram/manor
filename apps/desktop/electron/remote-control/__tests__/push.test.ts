/**
 * Push is the part of remote control that reaches a locked screen, so these tests are
 * mostly about restraint: exactly one push per subscribed device, nothing at
 * all for a revoked one, no scrollback in the payload, and a dead endpoint
 * dropped rather than retried forever.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { switchableBox } from "../../platform/__tests__/switchable-box";
import { SecretBoxUnavailableError } from "../../platform/secret-box";

// Stands in for the real module so the tests can see *whether* it is loaded:
// the factory only runs on the first `import("web-push")`.
const webPush = vi.hoisted(() => ({
  imports: 0,
  sendNotification: vi.fn(async () => ({})),
  generateVAPIDKeys: vi.fn(() => ({
    publicKey: "lazy-pub",
    privateKey: "lazy-priv",
  })),
}));

vi.mock("web-push", () => {
  webPush.imports += 1;
  return {
    sendNotification: webPush.sendNotification,
    generateVAPIDKeys: webPush.generateVAPIDKeys,
  };
});

const keychain = switchableBox();

import { RemoteDeviceStore } from "../devices";
import {
  PushManager,
  automationFailedPayload,
  isPushable,
  pushAutomationRun,
  pushPayloadFor,
} from "../push";

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

  beforeEach(async () => {
    keychain.setAvailable(true);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "manor-push-"));
    devices = new RemoteDeviceStore(
      keychain,
      path.join(dir, "devices.enc"),
    );
    await devices.init();
    send = vi.fn(async () => ({}));
    push = new PushManager(
      devices,
      keychain,
      path.join(dir, "vapid.enc"),
      send as never,
      () => ({ publicKey: "pub-key", privateKey: "priv-key" }),
    );
  });

  afterEach(async () => {
    await devices.flush();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function pairedWithPush(label = "phone") {
    const { device } = await devices.pair(label, "room", { direct: true });
    push.subscribe(device.id, SUBSCRIPTION);
    return device;
  }

  it("skips subscriptions the host server already pushes to", async () => {
    await pairedWithPush("phone");
    const other = (await devices.pair("tablet", "room", { direct: true })).device;
    push.subscribe(other.id, {
      ...SUBSCRIPTION,
      endpoint: "https://push.example/other",
    });
    const sent = await push.notify(
      { agentId: "a", title: "t", body: "b" },
      { skipEndpoints: new Set([SUBSCRIPTION.endpoint]) },
    );
    expect(sent).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({
      endpoint: "https://push.example/other",
    });
  });

  describe("importKeys", () => {
    const DESKTOP = { publicKey: "desktop-pub", privateKey: "desktop-priv" };

    it("replaces the active pair, persists it, and clears subscriptions made against the old one", async () => {
      const device = await pairedWithPush();
      expect(await push.publicKey()).toBe("pub-key");

      expect(await push.importKeys(DESKTOP)).toBe(true);
      expect(await push.publicKey()).toBe("desktop-pub");
      expect(await push.vapidKeys()).toEqual(DESKTOP);
      expect(devices.pushTargets()).toEqual([]);
      // The device itself stays paired.
      expect(devices.list().map((d) => d.id)).toEqual([device.id]);

      const reopened = new PushManager(
        devices,
        keychain,
        path.join(dir, "vapid.enc"),
        send as never,
        () => {
          throw new Error("must not regenerate");
        },
      );
      expect(await reopened.publicKey()).toBe("desktop-pub");
    });

    it("is idempotent: the same pair changes nothing and keeps subscriptions", async () => {
      await push.importKeys(DESKTOP);
      await pairedWithPush();
      expect(await push.importKeys(DESKTOP)).toBe(false);
      expect(devices.pushTargets()).toHaveLength(1);
    });

    it("signs pushes with the imported key", async () => {
      await push.importKeys(DESKTOP);
      await pairedWithPush();
      await push.notify({ agentId: "a", title: "t", body: "b" });
      expect(send.mock.calls[0][2]).toMatchObject({
        vapidDetails: { publicKey: "desktop-pub", privateKey: "desktop-priv" },
      });
    });

    it("refuses when it cannot encrypt, leaving the old pair", async () => {
      expect(await push.publicKey()).toBe("pub-key");
      keychain.setAvailable(false);
      await expect(push.importKeys(DESKTOP)).rejects.toThrow();
      expect(await push.publicKey()).toBe("pub-key");
    });

    it("a phone paired both ways hears once: same key, same endpoint, desktop skips", async () => {
      const hostDevices = new RemoteDeviceStore(keychain, path.join(dir, "host-devices.enc"));
      await hostDevices.init();
      const hostSend = vi.fn(async () => ({}));
      const host = new PushManager(
        hostDevices,
        keychain,
        path.join(dir, "host-vapid.enc"),
        hostSend as never,
        () => ({ publicKey: "host-own", privateKey: "host-own-priv" }),
      );
      await host.importKeys((await push.vapidKeys())!);
      expect(await host.publicKey()).toBe(await push.publicKey());

      // The phone's one browser subscription goes to both servers.
      await pairedWithPush();
      host.subscribe(
        (await hostDevices.pair("phone", "room", { direct: true })).device.id,
        SUBSCRIPTION,
      );

      const payload = { agentId: "a", title: "t", body: "b" };
      const hostSent = await host.notify(payload);
      const desktopSent = await push.notify(payload, {
        skipEndpoints: new Set(hostDevices.pushTargets().map((t) => t.subscription.endpoint)),
      });
      expect(hostSent + desktopSent).toBe(1);
      await hostDevices.flush();
    });
  });

  it("generates a key pair once and reuses it", async () => {
    const generate = vi.fn(() => ({
      publicKey: "pub-key",
      privateKey: "priv-key",
    }));
    const p = new PushManager(
      devices,
      keychain,
      path.join(dir, "vapid.enc"),
      send as never,
      generate,
    );
    expect(await p.publicKey()).toBe("pub-key");
    expect(await p.publicKey()).toBe("pub-key");
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("persists the key pair 0600 and reloads it", async () => {
    const file = path.join(dir, "vapid.enc");
    expect(await push.publicKey()).toBe("pub-key");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);

    const reopened = new PushManager(devices, keychain, file, send as never, () => {
      throw new Error("must not regenerate");
    });
    expect(await reopened.publicKey()).toBe("pub-key");
  });

  it("replaces a key file it cannot parse with a fresh pair", async () => {
    const file = path.join(dir, "vapid.enc");
    fs.writeFileSync(file, "{torn");
    await push.init();
    expect(await push.publicKey()).toBe("pub-key");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
      publicKey: "pub-key",
      privateKey: "priv-key",
    });
  });

  it("stays off, and leaves the key file alone, when the secret box could not run", async () => {
    const file = path.join(dir, "vapid.enc");
    fs.writeFileSync(file, JSON.stringify({ publicKey: "a", privateKey: "b" }));
    const p = new PushManager(
      devices,
      {
        ...keychain,
        decrypt: async () => {
          throw new SecretBoxUnavailableError("helper timed out");
        },
      },
      file,
      send as never,
      () => ({ publicKey: "pub-key", privateKey: "priv-key" }),
    );
    await expect(p.init()).rejects.toThrow(SecretBoxUnavailableError);
    expect(await p.publicKey()).toBeNull();
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
      publicKey: "a",
      privateKey: "b",
    });
  });

  it("refuses to store a key it cannot encrypt", async () => {
    keychain.setAvailable(false);
    const p = new PushManager(
      devices,
      keychain,
      path.join(dir, "vapid-2.enc"),
      send as never,
      () => ({ publicKey: "pub-key", privateKey: "priv-key" }),
    );
    expect(await p.publicKey()).toBeNull();
    expect(fs.existsSync(path.join(dir, "vapid-2.enc"))).toBe(false);
  });

  it("sends exactly one push per subscribed device", async () => {
    await pairedWithPush("phone");
    await pairedWithPush("tablet");
    expect(await push.notify(pushPayloadFor("requires_input", AGENT))).toBe(2);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("sends nothing to a device that never subscribed", async () => {
    await devices.pair("silent", "room", { direct: true });
    expect(await push.notify(pushPayloadFor("requires_input", AGENT))).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("sends nothing to a revoked device", async () => {
    const device = await pairedWithPush();
    await devices.revoke(device.id);
    expect(await push.notify(pushPayloadFor("error", AGENT))).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses to attach a subscription to an unknown device", () => {
    expect(push.subscribe("no-such-device", SUBSCRIPTION)).toBe(false);
  });

  it("drops an endpoint the push service has retired", async () => {
    await pairedWithPush();
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
    await pairedWithPush();
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    send.mockRejectedValueOnce(
      Object.assign(new Error("boom"), { statusCode: 500 }),
    );
    expect(await push.notify(pushPayloadFor("requires_input", AGENT))).toBe(0);
    expect(devices.pushTargets()).toHaveLength(1);
    spy.mockRestore();
  });

  it("sends no push at all when the key cannot be stored", async () => {
    await pairedWithPush();
    keychain.setAvailable(false);
    const p = new PushManager(
      devices,
      keychain,
      path.join(dir, "vapid-3.enc"),
      send as never,
      () => ({ publicKey: "pub-key", privateKey: "priv-key" }),
    );
    expect(await p.notify(pushPayloadFor("requires_input", AGENT))).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("carries the session and project, and nothing else", async () => {
    await pairedWithPush();
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

  it("hands out only the public half of the pair", async () => {
    // `publicKey()` is what reaches the phone, over the bridge; the private key
    // never leaves this module, and on disk it is safeStorage-encrypted at
    // 0600 (asserted above).
    expect(await push.publicKey()).toBe("pub-key");
  });
});

describe("PushManager loading web-push lazily", () => {
  let dir: string;
  let devices: RemoteDeviceStore;

  beforeEach(async () => {
    keychain.setAvailable(true);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "manor-push-lazy-"));
    devices = new RemoteDeviceStore(
      keychain,
      path.join(dir, "devices.enc"),
    );
    await devices.init();
  });

  afterEach(async () => {
    await devices.flush();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // One ordered test: the module cache is per-file, so "not yet imported" is
  // only observable before the first real use.
  it("imports web-push only once there is something to sign or send", async () => {
    const push = new PushManager(devices, keychain, path.join(dir, "vapid.enc"));

    // Nothing subscribed: no key, no module, and nothing written.
    expect(await push.notify(pushPayloadFor("requires_input", AGENT))).toBe(0);
    expect(webPush.imports).toBe(0);
    expect(fs.existsSync(path.join(dir, "vapid.enc"))).toBe(false);

    // A subscriber makes the default seams load it, once.
    const { device } = await devices.pair("phone", "room", { direct: true });
    push.subscribe(device.id, SUBSCRIPTION);
    expect(await push.notify(pushPayloadFor("requires_input", AGENT))).toBe(1);
    expect(await push.notify(pushPayloadFor("error", AGENT))).toBe(1);
    expect(webPush.imports).toBe(1);
    expect(webPush.generateVAPIDKeys).toHaveBeenCalledTimes(1);
    expect(webPush.sendNotification).toHaveBeenCalledTimes(2);
    expect(await push.publicKey()).toBe("lazy-pub");
  });

  it("generates one key pair for concurrent first callers", async () => {
    const generate = vi.fn(async () => ({
      publicKey: "pub-key",
      privateKey: "priv-key",
    }));
    const push = new PushManager(
      devices,
      keychain,
      path.join(dir, "vapid.enc"),
      vi.fn(async () => ({})) as never,
      generate,
    );
    const keys = await Promise.all([push.publicKey(), push.publicKey()]);
    expect(keys).toEqual(["pub-key", "pub-key"]);
    expect(generate).toHaveBeenCalledTimes(1);
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

describe("automation pushes", () => {
  it("titles an agent's push by the automation whose run started it", () => {
    const agent = { ...AGENT, automationName: "Morning PR triage" };
    expect(pushPayloadFor("requires_input", agent)).toEqual({
      agentId: "agent-1",
      title: "Morning PR triage needs input",
      body: "fix the thing — manor",
    });
    expect(pushPayloadFor("error", agent).title).toBe("Morning PR triage errored");
    expect(pushPayloadFor("requires_input", { ...AGENT, automationName: null }).title).toBe(
      "Agent needs input",
    );
  });

  it("says a run failed to start, and why", () => {
    expect(
      automationFailedPayload(
        { id: "auto-1", name: "Morning PR triage" },
        { detail: "The project isn't set up on this host" },
      ),
    ).toEqual({
      automationId: "auto-1",
      title: "Morning PR triage failed to start",
      body: "The project isn't set up on this host",
    });
  });

  it("pushes only a run that failed to start", () => {
    const notify = vi.fn().mockResolvedValue(1);
    const automation = { id: "auto-1", name: "Triage" };
    pushAutomationRun({ notify }, automation, { outcome: "started" }, null);
    pushAutomationRun({ notify }, automation, { outcome: "skipped", detail: "missed" }, null);
    expect(notify).not.toHaveBeenCalled();
    pushAutomationRun({ notify }, automation, { outcome: "failed", detail: "no project" }, null);
    expect(notify).toHaveBeenCalledWith(
      { automationId: "auto-1", title: "Triage failed to start", body: "no project" },
      undefined,
    );
  });

  it("names the host keeping the automation by the pushing server's room", () => {
    const notify = vi.fn().mockResolvedValue(1);
    pushAutomationRun(
      { notify },
      { id: "auto-1", name: "Triage" },
      { outcome: "failed", detail: "no project" },
      "room-box",
    );
    expect(notify).toHaveBeenCalledWith(
      {
        automationId: "auto-1",
        hostId: "room-box",
        title: "Triage failed to start",
        body: "no project",
      },
      undefined,
    );
  });
});
