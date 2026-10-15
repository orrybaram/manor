/**
 * The host server's own relay room (ADR-225 D3): dialled through the injected
 * WebSocket, paired with a link, devices refused the owner's methods, push,
 * VAPID and identity reset. See `harness.ts`.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";

import {
  eventually,
  hook,
  parsePairingUrl,
  useHostServerHarness,
} from "./harness";
import { WebSocket as WsWebSocket } from "ws";
import type { HostServerStatus } from "../relay";
import type { PairResult } from "../../remote-control/relay-room";
import type { RemoteDeviceInfo } from "../../remote-control/devices";

describe("host server: its own relay room (ADR-225 D3)", () => {
  const h = useHostServerHarness();

  it("dials its room through the injected WebSocket constructor", async () => {
    const server = await h.serve();
    await h.relayUp(server);
    expect(h.socketsMade).toBeGreaterThanOrEqual(1);
    const { roomId } = server.server.status().relay;
    expect(h.relay.liveHost?.roomId).toBe(roomId);
  });

  it("pairs a phone with a link to the room derived from its identity", async () => {
    const server = await h.serve();
    const client = await h.owner();
    const status = await client.invoke<HostServerStatus>(
      "hostServer",
      "status",
    );
    expect(status).toMatchObject({
      version: "1.2.3-test",
      secretBackend: "plaintext",
      devices: 0,
      pushEndpoints: [],
    });
    expect(status.relay.roomId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(status.uptimeMs).toBeGreaterThanOrEqual(0);

    const paired = await client.invoke<PairResult>(
      "remoteControl",
      "pair",
      "phone",
    );
    const link = parsePairingUrl(paired.pairingUrl);
    const origin = h.relay.url.replace("ws://", "http://");
    expect(link.base).toBe(`${origin}/app/1.2.3-test/`);
    expect(link.roomId).toBe(status.relay.roomId);
    expect(link.token).toBe(paired.rawToken);
    expect(paired.device).toMatchObject({ label: "phone", hasPush: false });

    const devices = await client.invoke<RemoteDeviceInfo[]>(
      "remoteControl",
      "listDevices",
    );
    expect(devices.map((d) => d.id)).toEqual([paired.device.id]);

    // The phone reaches this server's bridge through the room, as a device.
    await h.relayUp(server);
    const p = await h.phone(paired.pairingUrl);
    const agents = await p.call("agents", "getAll");
    expect(agents).toMatchObject({ ok: true, result: [] });
  });

  it("refuses a device the owner's methods", async () => {
    const server = await h.serve();
    await h.relayUp(server);
    const client = await h.owner();
    const paired = await client.invoke<PairResult>(
      "remoteControl",
      "pair",
      "phone",
    );
    const p = await h.phone(paired.pairingUrl);
    for (const [ns, methodName, ...args] of [
      ["remoteControl", "pair", "another"],
      ["remoteControl", "listDevices"],
      ["remoteControl", "revoke", paired.device.id],
      ["hostServer", "status"],
      ["hostServer", "resetIdentity"],
      ["projects", "add", "Manor", "/tmp"],
      ["hostServer", "setVapidKeys", { publicKey: "a", privateKey: "b" }],
    ] as Array<[string, string, ...unknown[]]>) {
      expect(await p.call(ns, methodName, ...args)).toMatchObject({
        ok: false,
        code: "unavailable:host",
      });
    }
    // Nothing changed hands.
    expect(
      await client.invoke<RemoteDeviceInfo[]>("remoteControl", "listDevices"),
    ).toHaveLength(1);
  });

  it("revokes a device and closes its channel", async () => {
    const server = await h.serve();
    await h.relayUp(server);
    const client = await h.owner();
    const paired = await client.invoke<PairResult>(
      "remoteControl",
      "pair",
      "phone",
    );
    const p = await h.phone(paired.pairingUrl);
    expect(
      await client.invoke("remoteControl", "revoke", paired.device.id),
    ).toEqual([]);
    await eventually(
      () =>
        p.viewer.frames.some((f) => f.kind === "close") ||
        p.viewer.ws.readyState >= WsWebSocket.CLOSING,
      Boolean,
      "revoked channel closed",
    );
  });

  it("pushes a requires_input transition to a subscribed phone", async () => {
    const server = await h.serve();
    await h.relayUp(server);
    const client = await h.owner();
    const paired = await client.invoke<PairResult>(
      "remoteControl",
      "pair",
      "phone",
    );
    const p = await h.phone(paired.pairingUrl);
    expect(await p.call("remoteControl", "vapidPublicKey")).toMatchObject({
      ok: true,
      result: "vapid-pub",
    });
    const subscription = {
      endpoint: "https://push.example/endpoint-1",
      keys: { p256dh: "p256", auth: "auth" },
    };
    expect(
      await p.call("remoteControl", "subscribePush", subscription),
    ).toMatchObject({ ok: true, result: true });
    // The owner can't subscribe: there is no device behind it.
    await expect(
      client.invoke("remoteControl", "subscribePush", subscription),
    ).rejects.toThrow();

    expect(
      (await client.invoke<HostServerStatus>("hostServer", "status"))
        .pushEndpoints,
    ).toEqual(["https://push.example/endpoint-1"]);

    h.daemon.emitHook(hook("SessionStart"));
    h.daemon.emitHook(hook("UserPromptSubmit"));
    h.daemon.emitHook(hook("PermissionRequest"));
    await eventually(() => h.pushes.length > 0, Boolean, "a push");
    expect(h.pushes).toEqual([
      {
        endpoint: "https://push.example/endpoint-1",
        payload: expect.objectContaining({ title: "Agent needs input" }),
      },
    ]);
  });

  it("signs with the desktop's VAPID key, and clears subscriptions only when it changes", async () => {
    const server = await h.serve();
    await h.relayUp(server);
    const client = await h.owner();
    const paired = await client.invoke<PairResult>(
      "remoteControl",
      "pair",
      "phone",
    );
    const p = await h.phone(paired.pairingUrl);
    const subscription = {
      endpoint: "https://push.example/endpoint-1",
      keys: { p256dh: "p256", auth: "auth" },
    };
    const endpoints = async () =>
      (await client.invoke<HostServerStatus>("hostServer", "status"))
        .pushEndpoints;

    expect(await p.call("remoteControl", "vapidPublicKey")).toMatchObject({
      result: "vapid-pub",
    });
    await p.call("remoteControl", "subscribePush", subscription);
    expect(await endpoints()).toEqual(["https://push.example/endpoint-1"]);

    // The host's own pair is replaced; the subscription was made against
    // the old key, so it goes.
    const desktop = { publicKey: "desktop-pub", privateKey: "desktop-priv" };
    expect(await client.invoke("hostServer", "setVapidKeys", desktop)).toBe(
      true,
    );
    expect(await p.call("remoteControl", "vapidPublicKey")).toMatchObject({
      result: "desktop-pub",
    });
    expect(await endpoints()).toEqual([]);

    // The phone re-subscribes; the same key again leaves that alone.
    await p.call("remoteControl", "subscribePush", subscription);
    // `false`: unchanged, so nothing was cleared.
    expect(await client.invoke("hostServer", "setVapidKeys", desktop)).toBe(
      false,
    );
    expect(await endpoints()).toEqual(["https://push.example/endpoint-1"]);
    expect(
      fs.existsSync(h.paths.vapid) &&
        fs.readFileSync(h.paths.vapid, "utf-8").includes("desktop-priv"),
    ).toBe(true);

    // Malformed keys are refused whole.
    await expect(
      client.invoke("hostServer", "setVapidKeys", { publicKey: "x" }),
    ).rejects.toThrow();
    expect(await p.call("remoteControl", "vapidPublicKey")).toMatchObject({
      result: "desktop-pub",
    });
  });

  it("resetIdentity moves to a new room and revokes every device", async () => {
    const server = await h.serve();
    await h.relayUp(server);
    const client = await h.owner();
    const before = await client.invoke<HostServerStatus>(
      "hostServer",
      "status",
    );
    const paired = await client.invoke<PairResult>(
      "remoteControl",
      "pair",
      "phone",
    );
    const p = await h.phone(paired.pairingUrl);
    await p.call("remoteControl", "subscribePush", {
      endpoint: "https://push.example/endpoint-1",
      keys: { p256dh: "p256", auth: "auth" },
    });

    const after = await client.invoke<HostServerStatus>(
      "hostServer",
      "resetIdentity",
    );
    expect(after.relay.roomId).not.toBe(before.relay.roomId);
    expect(after.devices).toBe(0);
    expect(after.pushEndpoints).toEqual([]);
    expect(await client.invoke("remoteControl", "listDevices")).toEqual([]);

    // The connector holds the new room.
    await eventually(
      () => h.relay.liveHost?.roomId === after.relay.roomId,
      Boolean,
      "connector on the new room",
    );
    // The old link is dead: its token no longer passes the hello.
    const relink = await client.invoke<PairResult>(
      "remoteControl",
      "pair",
      "phone-2",
    );
    expect(parsePairingUrl(relink.pairingUrl).roomId).toBe(after.relay.roomId);

    // And it survives a restart: the identity was persisted.
    await h.stop();
    const again = await h.serve();
    expect(again.server.status().relay.roomId).toBe(after.relay.roomId);
  });
});
