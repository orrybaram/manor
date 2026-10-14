/**
 * Why no server can answer a Linear call for a host (ADR-228 D10): each of
 * the host and the desktop that lists it either has Linear off or is away.
 */

import { describe, expect, it } from "vitest";

import type { BridgeTransport } from "../client";
import { createLinearServers } from "../linear-servers";
import { createServerSet } from "../server-set";

function transport(linear: boolean): BridgeTransport {
  return {
    start() {},
    rendererId: null,
    platform: "web",
    rootValues: {},
    localNamespaces: {},
    locallyServed: {},
    invoke: (ns, method) =>
      Promise.resolve(ns === "linear" && method === "isConnected" ? linear : null),
    subscribe: () => () => {},
  };
}

/** A phone holding a desktop ("mac") and a host it lists ("wsl-box"). */
function phone(host: "off" | "away", desktop: "off" | "away") {
  const set = createServerSet();
  set.add("deskroom", transport(false), { home: true, lists: "all", roomId: "deskroom" });
  set.recordHello("deskroom", { hostName: "mac", hostServer: false });
  set.add("boxroom", transport(false), { roomId: "boxroom" });
  set.recordHello("boxroom", { hostName: "wsl-box", hostServer: true });
  set.setReachability("deskroom", desktop === "away" ? "unreachable" : "connected");
  set.setReachability("boxroom", host === "away" ? "unreachable" : "connected");
  return createLinearServers(set);
}

describe("the refusal when neither the host nor its desktop has Linear", () => {
  it.each([
    ["off", "off", "Linear isn't turned on for wsl-box, and Linear isn't connected on mac"],
    ["off", "away", "Linear isn't turned on for wsl-box, and mac is away"],
    ["away", "off", "wsl-box is away, and Linear isn't connected on mac"],
    ["away", "away", "wsl-box and mac are both away"],
  ] as const)("host %s, desktop %s: %s", async (host, desktop, refusal) => {
    expect(await phone(host, desktop).choose("boxroom")).toEqual({ refusal });
  });
});
