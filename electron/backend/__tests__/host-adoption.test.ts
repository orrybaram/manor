/**
 * `HostAdoption` against a fake owner channel (ADR-227 D3): when it sends,
 * and that nothing local is touched without the host's ack. The real round
 * trip is `host-server/__tests__/adoption.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AdoptionBundle } from "../../host-server/adopt";
import type { HostServerStatus } from "../../host-server/relay";
import type { AdoptionChannel } from "../host-adoption";
import { BOX_WT, openDesktop, seedDesktop } from "./adoption-fixtures";

function fakeChannel(ownership: unknown, ack: unknown = "host") {
  const sent: AdoptionBundle[] = [];
  const channel = {
    api: {
      hostServer: {
        status: vi.fn(async () => ({ ownership }) as unknown as HostServerStatus),
        adopt: vi.fn(async (bundle: AdoptionBundle) => {
          sent.push(bundle);
          return { ownership: ack } as unknown as HostServerStatus;
        }),
      },
    },
  } satisfies AdoptionChannel;
  return { channel, sent };
}

describe("HostAdoption (ADR-227 D3)", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "manor-host-adoption-"));
    seedDesktop(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("builds the bundle from the host's records, rewritten to the box's view", async () => {
    const desktop = openDesktop(dir);
    const { channel, sent } = fakeChannel("pending");
    await desktop.adoption.run("box", channel);
    expect(sent).toHaveLength(1);
    const [bundle] = sent;
    expect(bundle.projects.map((p) => p.id)).toEqual(["box-app", "box-other"]);
    expect(bundle.projects.every((p) => p.hostId === "local")).toBe(true);
    expect(bundle.agents.map((a) => [a.id, a.hostId])).toEqual(
      expect.arrayContaining([
        ["box-1", "local"],
        ["box-2", "local"],
      ]),
    );
    expect(bundle.agents).toHaveLength(2);
    expect(Object.keys(bundle.layout.workspaces).sort()).toEqual(
      ["/home/me/box-app", BOX_WT].sort(),
    );
    expect(Object.values(bundle.layout.workspaces).every((e) => e.claims.length === 0)).toBe(true);
    expect(bundle.layout.lastActiveWorkspacePath).toBe(BOX_WT);
  });

  it("counts an agent on the host its pane is on now", async () => {
    const desktop = openDesktop(dir, {
      // `mac-1` has no pane; `box-1`'s pane moved to the mac.
      getPaneHostId: (paneId) => (paneId === "pane-box" ? "mac" : undefined),
    });
    const { channel, sent } = fakeChannel("pending");
    await desktop.adoption.run("box", channel);
    expect(sent[0].agents.map((a) => a.id)).toEqual(["box-2"]);
  });

  it("touches nothing local without the host's ack", async () => {
    const desktop = openDesktop(dir);
    const { channel } = fakeChannel("pending", "pending");
    await expect(desktop.adoption.run("box", channel)).rejects.toThrow(/did not take/);
    expect(desktop.projectManager.manifestRecords("box")).toHaveLength(2);
    expect(desktop.agentManager.getAllAgents()).toHaveLength(4);
    expect(Object.keys(desktop.layoutStore.getAll())).toHaveLength(4);
    expect(desktop.projectManager.isHostAdopted("box")).toBe(false);
    expect(fs.existsSync(path.join(dir, "backups"))).toBe(false);
  });

  it("leaves a host server from before the flip alone", async () => {
    const desktop = openDesktop(dir);
    const { channel } = fakeChannel(undefined);
    expect(await desktop.adoption.run("box", channel)).toMatchObject({
      ownership: null,
      sent: false,
    });
    expect(channel.api.hostServer.adopt).not.toHaveBeenCalled();
    expect(desktop.projectManager.manifestRecords("box")).toHaveLength(2);
    expect(desktop.projectManager.isHostAdopted("box")).toBe(false);
  });

  it("sends leftovers to a host that already owns itself, and nothing once they are gone", async () => {
    const desktop = openDesktop(dir);
    const { channel } = fakeChannel("host");
    expect(await desktop.adoption.run("box", channel)).toMatchObject({ sent: true });
    expect(await desktop.adoption.run("box", channel)).toMatchObject({ sent: false });
    expect(channel.api.hostServer.adopt).toHaveBeenCalledTimes(1);
    expect(desktop.projectManager.isHostAdopted("box")).toBe(true);
    // The other host is untouched.
    expect(desktop.projectManager.manifestRecords("mac")).toHaveLength(1);
    expect(desktop.projectManager.isHostAdopted("mac")).toBe(false);
  });

  it("leaves what the desktop records for a host after handing it over", async () => {
    const desktop = openDesktop(dir);
    desktop.projectManager.markHostAdopted("box");
    const { channel } = fakeChannel("host");
    expect(await desktop.adoption.run("box", channel)).toMatchObject({
      ownership: "host",
      sent: false,
    });
    expect(channel.api.hostServer.adopt).not.toHaveBeenCalled();
    expect(desktop.projectManager.manifestRecords("box")).toHaveLength(2);
    expect(desktop.agentManager.getAllAgents()).toHaveLength(4);
  });

  it("hands over again to a host that has lost its records", async () => {
    const desktop = openDesktop(dir);
    desktop.projectManager.markHostAdopted("box");
    const { channel, sent } = fakeChannel("pending");
    expect(await desktop.adoption.run("box", channel)).toMatchObject({ sent: true });
    expect(sent[0].projects.map((p) => p.id)).toEqual(["box-app", "box-other"]);
    expect(desktop.projectManager.manifestRecords("box")).toEqual([]);
  });

  it("runs one adoption per host at a time", async () => {
    const desktop = openDesktop(dir);
    const { channel, sent } = fakeChannel("pending");
    const [first, second] = await Promise.all([
      desktop.adoption.run("box", channel),
      desktop.adoption.run("box", channel),
    ]);
    // The second read the stores after the first had let go of them.
    expect(first.removed).toEqual({ projects: 2, agents: 2, workspaces: 2 });
    expect(second.removed).toEqual({ projects: 0, agents: 0, workspaces: 0 });
    expect(sent[1]).toMatchObject({ projects: [], agents: [], layout: { workspaces: {} } });
  });
});
