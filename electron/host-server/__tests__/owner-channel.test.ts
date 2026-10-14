/**
 * The owner channel (ADR-225 D4) and what the owner alone may do on a host
 * server that owns its host (ADR-227 D2, D3, D6): its ownership state, the
 * slice-1 snapshots it discards, and project setup a device is refused.
 * See `harness.ts`.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";

import { eventually, useHostServerHarness } from "./harness";
import { ownerTokenAuthenticator } from "../socket";
import { HostServerUnavailableError } from "../../backend/host-server-client";
import type { HostServerStatus } from "../relay";
import type { PairResult } from "../../remote-control/relay-room";

describe("the owner channel (ADR-225 D4)", () => {
  const h = useHostServerHarness();

  it("authenticates the owner token, and only it, as the owner", () => {
    const auth = ownerTokenAuthenticator("tok");
    expect(auth("tok")).toEqual({
      ok: true,
      caller: { callerClass: "owner", deviceId: null, deviceLabel: null },
    });
    expect(auth("nope")).toMatchObject({ ok: false, code: 4401 });
    expect(auth(undefined)).toMatchObject({ ok: false, code: 4401 });
  });

  it("records a desktop viewer stream as the owner with the viewer fact (ADR-228 D4)", () => {
    const auth = ownerTokenAuthenticator("tok");
    expect(auth("tok", { type: "hello", token: "tok", viewer: "desktop" })).toEqual({
      ok: true,
      caller: {
        callerClass: "owner",
        viewer: "desktop",
        deviceId: null,
        deviceLabel: null,
      },
    });
    // An older desktop's hello, or any other value, is main's owner channel.
    for (const hello of [{ type: "hello", token: "tok" }, { viewer: "phone" }]) {
      expect(auth("tok", hello)).toEqual({
        ok: true,
        caller: { callerClass: "owner", deviceId: null, deviceLabel: null },
      });
    }
    // Saying it is no credential.
    expect(auth("nope", { viewer: "desktop" })).toMatchObject({ ok: false, code: 4401 });
  });

  it("reports the viewer-bridge capability and its relay room in its status (ADR-228)", async () => {
    const server = await h.serve();
    await h.relayUp(server);
    const client = await h.owner();
    const status = await client.invoke<HostServerStatus>("hostServer", "status");
    expect(status.capabilities).toContain("viewer-bridge");
    expect(status.roomId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    // The room the relay addresses, and the one a phone's pairing stores.
    expect(status.roomId).toBe(status.relay.roomId);
    expect(h.relay.liveHost?.roomId).toBe(status.roomId);
    const paired = await client.invoke<PairResult>("remoteControl", "pair", "phone");
    expect(paired.pairingUrl).toContain(`#relay=${status.roomId}.`);
  });

  it("reports a phone's pane or chat subscription as viewing.device (ADR-230 D1)", async () => {
    const server = await h.serve();
    await h.relayUp(server);
    const client = await h.owner();
    const paired = await client.invoke<PairResult>("remoteControl", "pair", "phone");
    const phone = await h.phone(paired.pairingUrl);
    const viewing = async () =>
      (await client.invoke<HostServerStatus>("hostServer", "status")).viewing;
    expect(await viewing()).toEqual({ desktop: false, device: false, forwarded: false });

    phone.viewer.send({ kind: "subscribe", ns: "pty", event: "output", key: "p1" });
    await eventually(viewing, (v) => v?.device === true, "the phone watching", 3_000);
    expect(await viewing()).toEqual({ desktop: false, device: true, forwarded: false });
  });

  it("names itself in the hello by the box's own name", async () => {
    const server = await h.serve();
    await h.relayUp(server);
    const client = await h.owner();
    const paired = await client.invoke<PairResult>(
      "remoteControl",
      "pair",
      "phone",
    );
    const phone = await h.phone(paired.pairingUrl);
    expect(phone.hello.hostName).toBe(os.hostname());
  });

  it("is pending until adopted: no projects, and project and layout writes refused", async () => {
    await h.serve();
    const client = await h.owner();
    expect(
      await client.invoke<HostServerStatus>("hostServer", "status"),
    ).toMatchObject({ ownership: "pending" });
    expect(await client.invoke("projects", "getAll")).toEqual([]);
    for (const [ns, methodName, ...args] of [
      ["projects", "add", "Manor", h.tmp],
      ["projects", "createWorktree", "p1", "feature"],
      ["layout", "apply", h.tmp, { type: "new-tab", tab: {} }],
      ["layout", "setPendingCommand", "pane-x", "claude", "agent-startup"],
    ] as const) {
      await expect(
        client.invoke(ns, methodName, ...args),
      ).rejects.toMatchObject({
        name: "HostServerUnavailableError",
        message: expect.stringMatching(/This host is being set up/),
      });
    }
    // Nothing was written.
    expect(fs.existsSync(h.paths.projects)).toBe(false);
    expect(fs.existsSync(h.paths.ownership)).toBe(false);
  });

  it("reports host once adopted, and keeps it across a restart", async () => {
    h.adopt();
    await h.serve();
    const client = await h.owner();
    expect(
      await client.invoke<HostServerStatus>("hostServer", "status"),
    ).toMatchObject({ ownership: "host" });
    await h.stop();
    await h.serve();
    const again = await h.owner();
    expect(
      await again.invoke<HostServerStatus>("hostServer", "status"),
    ).toMatchObject({ ownership: "host" });
  });

  it("discards slice 1's manifest and layout snapshot at boot, and keeps its own layout", async () => {
    fs.writeFileSync(h.paths.legacyManifest, JSON.stringify({ version: 1, projects: [] }));
    fs.writeFileSync(
      h.paths.layout,
      JSON.stringify({
        version: 1,
        takenAt: "2026-10-12T10:00:00.000Z",
        workspaces: { "/home/me/a": {} },
        lastActiveWorkspacePath: null,
      }),
    );
    await h.serve();
    const client = await h.owner();
    expect(fs.existsSync(h.paths.legacyManifest)).toBe(false);
    expect(fs.existsSync(h.paths.layout)).toBe(false);
    expect(await client.invoke("layout", "getAll")).toEqual({});
    // Never asked for again: the owner no longer pushes either.
    for (const methodName of ["syncManifest", "syncLayout"]) {
      await expect(
        client.invoke("hostServer", methodName, {}),
      ).rejects.toBeInstanceOf(HostServerUnavailableError);
    }
  });

  it("leaves project setup to the owner: a device cannot add, change or remove a project", async () => {
    h.adopt();
    const server = await h.serve();
    await h.relayUp(server);
    const client = await h.owner();
    const paired = await client.invoke<PairResult>(
      "remoteControl",
      "pair",
      "phone",
    );
    const p = await h.phone(paired.pairingUrl);
    for (const [methodName, ...args] of [
      ["add", "Manor", h.tmp],
      ["clone", { hostId: "local", repoUrl: "x", targetDir: h.tmp, name: "x" }],
      ["update", "p1", { color: "#f00" }],
      ["remove", "p1"],
    ] as const) {
      expect(await p.call("projects", methodName, ...args)).toMatchObject({
        ok: false,
        code: "unavailable:host",
      });
    }
    expect(fs.existsSync(h.paths.projects)).toBe(false);
  });
});
