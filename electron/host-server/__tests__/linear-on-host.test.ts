/**
 * "Use Linear on <host>" (ADR-227 D7): the desktop's key set and cleared over
 * the owner channel, `linear.*` unavailable until it is there, and "Reset
 * pairing keys" deleting it. See `harness.ts`.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";

import { useHostServerHarness } from "./harness";
import type { PairResult } from "../../remote-control/relay-room";

describe("host server: Linear on the host (ADR-227 D7)", () => {
  const h = useHostServerHarness();

  it("sets, reports and clears the token, sealed in the host's own file", async () => {
    const server = await h.serve();
    const client = await h.owner();
    expect(server.server.status().linear).toBe(false);

    expect(await client.invoke("hostServer", "setLinearToken", "lin_api_key")).toBe(true);
    expect(server.server.status().linear).toBe(true);
    expect(fs.existsSync(h.paths.linearToken)).toBe(true);

    expect(await client.invoke("hostServer", "setLinearToken", null)).toBe(false);
    expect(server.server.status().linear).toBe(false);
    expect(fs.existsSync(h.paths.linearToken)).toBe(false);
  });

  it("keeps the token across a restart", async () => {
    await h.serve();
    const client = await h.owner();
    await client.invoke("hostServer", "setLinearToken", "lin_api_key");
    await h.stop();
    const again = await h.serve();
    expect(again.server.status().linear).toBe(true);
  });

  it("refuses an empty token", async () => {
    await h.serve();
    const client = await h.owner();
    await expect(client.invoke("hostServer", "setLinearToken", "  ")).rejects.toThrow();
  });

  it("answers linear.* unavailable:host until a token is set", async () => {
    const server = await h.serve();
    await h.relayUp(server);
    const client = await h.owner();
    const paired = await client.invoke<PairResult>("remoteControl", "pair", "phone");
    const p = await h.phone(paired.pairingUrl);

    for (const [name, ...args] of [
      ["getViewer"],
      ["getTeams"],
      ["getMyIssues", ["t1"]],
      ["getAllIssues", ["t1"]],
      ["getIssueDetail", "i1"],
      ["startIssue", "i1"],
      ["closeIssue", "i1"],
      ["proxyImage", "https://uploads.linear.app/x.png"],
      ["autoMatch"],
    ] as Array<[string, ...unknown[]]>) {
      const reply = await p.call("linear", name, ...args);
      expect(reply).toMatchObject({ ok: false, code: "unavailable:host" });
      expect(JSON.stringify(reply)).toMatch(/Linear isn't turned on for/);
    }
    expect(await p.call("linear", "isConnected")).toMatchObject({ ok: true, result: false });

    // Connecting and disconnecting stay the desktop's; a phone cannot set the key.
    for (const [ns, name, ...args] of [
      ["linear", "connect", "k"],
      ["linear", "disconnect"],
      ["hostServer", "setLinearToken", "k"],
    ] as Array<[string, string, ...unknown[]]>) {
      expect(await p.call(ns, name, ...args)).toMatchObject({
        ok: false,
        code: "unavailable:host",
      });
    }

    await client.invoke("hostServer", "setLinearToken", "lin_api_key");
    expect(await p.call("linear", "isConnected")).toMatchObject({ ok: true, result: true });
    // Past the gate: the call is made (and fails to reach Linear), no longer refused.
    const past = await p.call("linear", "getTeams");
    expect(past).not.toMatchObject({ code: "unavailable:host" });
  });

  it("Reset pairing keys deletes the copy", async () => {
    const server = await h.serve();
    const client = await h.owner();
    await client.invoke("hostServer", "setLinearToken", "lin_api_key");
    const status = await client.invoke<{ linear: boolean }>("hostServer", "resetIdentity");
    expect(status.linear).toBe(false);
    expect(server.server.status().linear).toBe(false);
    expect(fs.existsSync(h.paths.linearToken)).toBe(false);
  });
});
