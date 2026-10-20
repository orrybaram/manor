/**
 * A data dir copied to another instance gets a new identity:
 * new room, no devices, and the owner is told once. See `harness.ts`.
 */

import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useHostServerHarness } from "./harness";
import type { HostServerStatus } from "../relay";
import type { PairResult } from "../../remote-control/relay-room";

describe("host server: one identity per instance", () => {
  const h = useHostServerHarness();
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("resets the relay room on a copied data dir, keeps projects, and says so once", async () => {
    vi.stubEnv("MANOR_INSTANCE_ID", "instance-a");
    const first = await h.serve();
    const client = await h.owner();
    await client.invoke<PairResult>("remoteControl", "pair", "phone");
    const before = first.server.status();
    expect(before.devices).toBe(1);
    expect(before.identityReset).toBeNull();
    await h.stop();
    expect(
      JSON.parse(fs.readFileSync(h.paths.instance, "utf8")),
    ).toEqual({ instanceId: "instance-a" });
    const projectsFile = JSON.stringify({ projects: [], selectedProjectIndex: 0 });
    fs.writeFileSync(h.paths.projects, projectsFile);

    vi.stubEnv("MANOR_INSTANCE_ID", "instance-b");
    const second = await h.serve();
    const owner = await h.owner();
    const status = await owner.invoke<HostServerStatus>("hostServer", "status");
    expect(status.identityReset).toBe("cloned");
    expect(status.devices).toBe(0);
    expect(status.relay.roomId).not.toBe(before.relay.roomId);
    expect(fs.readFileSync(h.paths.projects, "utf8")).toBe(projectsFile);
    expect(JSON.parse(fs.readFileSync(h.paths.instance, "utf8"))).toEqual({
      instanceId: "instance-b",
    });
    // Read once: the next status no longer carries it.
    expect(second.server.status().identityReset).toBeNull();
  });
});
