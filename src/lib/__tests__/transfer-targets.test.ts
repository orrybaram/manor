import { describe, it, expect } from "vitest";
import type { HostStatusInfo } from "../../store/host-store";
import { transferTargets } from "../transfer-targets";

function host(hostId: string, status: HostStatusInfo["status"] = "connected"): HostStatusInfo {
  return { hostId, spec: { kind: "ssh", target: `me@${hostId}` }, status };
}

const GROUP = { memberIds: ["a", "b"] };
const hosts = [host("box"), host("cloud")];

describe("transferTargets", () => {
  it("lists this machine first, then remotes, minus the project's host", () => {
    const a = { id: "a", hostId: "local" };
    expect(transferTargets(a, [a], hosts, "copy").map((t) => [t.hostId, t.label])).toEqual([
      ["box", "me@box"],
      ["cloud", "me@cloud"],
    ]);
    const b = { id: "b", hostId: "box" };
    expect(transferTargets(b, [b], hosts, "move").map((t) => [t.hostId, t.label])).toEqual([
      ["local", "This machine"],
      ["cloud", "me@cloud"],
    ]);
  });

  it("gives an unlinked project targets, none disabled", () => {
    const a = { id: "a", hostId: "local", group: null };
    expect(transferTargets(a, [a], hosts, "copy").map((t) => t.disabledReason)).toEqual([
      null,
      null,
    ]);
  });

  it("disables a host the group already has a member on, for copy and move", () => {
    const a = { id: "a", hostId: "local", group: GROUP };
    const b = { id: "b", hostId: "box", group: GROUP };
    for (const mode of ["copy", "move"] as const) {
      const targets = transferTargets(a, [a, b], hosts, mode);
      expect(targets.find((t) => t.hostId === "box")?.disabledReason).toBe("Already on me@box");
      expect(targets.find((t) => t.hostId === "cloud")?.disabledReason).toBeNull();
    }
    const fromBox = transferTargets(b, [a, b], hosts, "move");
    expect(fromBox.find((t) => t.hostId === "local")?.disabledReason).toBe(
      "Already on This machine",
    );
  });

  it("disables a host whose last connect failed, but not a merely disconnected one", () => {
    const a = { id: "a", hostId: "local" };
    const targets = transferTargets(
      a,
      [a],
      [host("box", "error"), host("cloud", "disconnected")],
      "move",
    );
    expect(targets[0].disabledReason).toMatch(/^me@box is offline/);
    expect(targets[1].disabledReason).toBeNull();
  });
});
