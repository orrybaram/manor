import { describe, expect, it } from "vitest";
import { hostNotices } from "../host-notices";

describe("hostNotices", () => {
  it("names each remote host that isn't connected, and why", () => {
    const notices = hostNotices([
      { hostId: "local", status: "connected", spec: null },
      { hostId: "box", status: "connected", spec: { kind: "ssh", target: "me@box" } },
      { hostId: "dev", status: "disconnected", spec: { kind: "ssh", target: "me@dev" } },
      { hostId: "pod", status: "sleeping", spec: { kind: "recipe", recipeId: "r" }, label: "GPU pod" },
      { hostId: "far", status: "error", spec: { kind: "ssh", target: "far" } },
    ]);
    expect(notices).toEqual([
      { hostId: "dev", message: "Sessions on me@dev aren't shown — it isn't connected" },
      { hostId: "pod", message: "Sessions on GPU pod aren't shown — it's asleep" },
      { hostId: "far", message: "Sessions on far aren't shown — it can't be reached" },
    ]);
  });

  it("has nothing to say when every host is up", () => {
    expect(hostNotices([{ hostId: "box", status: "connected", spec: null }])).toEqual([]);
  });
});
