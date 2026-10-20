import { describe, it, expect, vi } from "vitest";
import type { BridgeTransport } from "../../bridge/client";
import { recordPairingHello, upsertPairing } from "../../bridge/pairings";
import { servers } from "../../bridge/server-set";
import { base64urlEncode } from "@manor/protocol/relay-crypto";
import type { HostStatusInfo } from "../../store/host-store";
import {
  disambiguateHostLabels,
  hasHiddenPods,
  newHostTargets,
  transferTargets,
} from "../transfer-targets";

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

  it("names the desktop's own machine by its pairing on a phone", () => {
    const map = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    });
    const room = "AbCdEfGhIjKlMnOpQr_-01";
    upsertPairing({ roomId: room, serverKey: base64urlEncode(new Uint8Array(32)), token: "t" });
    recordPairingHello(room, { hostName: "desk.local", hostServer: false });
    const transport = { invoke: () => new Promise(() => {}), subscribe: () => () => {} };
    servers.add(room, transport as unknown as BridgeTransport, { home: true, roomId: room });
    try {
      const b = { id: "b", hostId: "box" };
      expect(transferTargets(b, [b], hosts, "move")[0].label).toBe("desk.local");
    } finally {
      servers.remove(room);
      vi.unstubAllGlobals();
    }
  });
});

describe("newHostTargets", () => {
  it("makes one target per profile, worded for its template", () => {
    expect(
      newHostTargets([
        { id: "hp-1", name: "Work cluster", templateId: "kubernetes" },
        { id: "hp-2", name: "Laptop", templateId: "docker" },
      ]),
    ).toEqual([
      { kind: "newHost", profileId: "hp-1", label: "In a new pod · Work cluster" },
      { kind: "newHost", profileId: "hp-2", label: "In a new container · Laptop" },
    ]);
  });

  it("is empty without profiles", () => {
    expect(newHostTargets([])).toEqual([]);
  });
});

function pod(hostId: string, forProject?: string, recipeId = `r-${hostId}`): HostStatusInfo {
  return {
    hostId,
    spec: { kind: "recipe", recipeId },
    label: "repo",
    status: "connected",
    ...(forProject ? { forProject } : {}),
  };
}

describe("pods of other projects", () => {
  const podHosts = [host("box"), pod("podA", "a"), pod("podB", "x")];

  it("hides another project's pod, keeps the project's and its group's own", () => {
    const group = { memberIds: ["a", "b"] };
    const a = { id: "a", hostId: "local", group };
    expect(transferTargets(a, [a], podHosts, "copy").map((t) => t.hostId)).toEqual([
      "box",
      "podA",
    ]);
    const b = { id: "b", hostId: "local", group };
    expect(transferTargets(b, [b], podHosts, "copy").map((t) => t.hostId)).toContain("podA");
    const c = { id: "c", hostId: "local" };
    expect(transferTargets(c, [c], podHosts, "copy").map((t) => t.hostId)).toEqual(["box"]);
  });

  it("brings them back with showAllHosts", () => {
    const c = { id: "c", hostId: "local" };
    const ids = transferTargets(c, [c], podHosts, "copy", { showAllHosts: true }).map(
      (t) => t.hostId,
    );
    expect(ids).toEqual(["box", "podA", "podB"]);
  });

  it("keeps the one host named by include", () => {
    const c = { id: "c", hostId: "local" };
    const ids = transferTargets(c, [c], podHosts, "copy", { include: "podB" }).map(
      (t) => t.hostId,
    );
    expect(ids).toEqual(["box", "podB"]);
  });

  it("reports whether any pod is hidden", () => {
    expect(hasHiddenPods({ id: "c", hostId: "local" }, podHosts)).toBe(true);
    expect(hasHiddenPods({ id: "a", hostId: "local" }, [pod("podA", "a")])).toBe(false);
  });
});

describe("disambiguateHostLabels", () => {
  it("suffixes only duplicate names", () => {
    const hs = [pod("p1", "a", "recipe-abc123"), pod("p2", "b", "recipe-def456"), host("box")];
    const items = [
      { hostId: "p1", label: "repo" },
      { hostId: "p2", label: "repo" },
      { hostId: "box", label: "me@box" },
    ];
    expect(disambiguateHostLabels(items, hs).map((i) => i.label)).toEqual([
      "repo (abc123)",
      "repo (def456)",
      "me@box",
    ]);
  });
});
