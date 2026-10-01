import { describe, expect, it } from "vitest";

import type { RelayStatus, TunnelStatus } from "../../../../electron.d";
import { describeExposure } from "../remote-exposure";

const off = { state: "stopped", url: null, error: null } as const;

function status(
  tunnel: Partial<TunnelStatus> = {},
  relay: Partial<RelayStatus> = {},
  counts: { listeners?: number; relayViewers?: number } = {},
) {
  return {
    tunnel: { ...off, ...tunnel },
    relay: { ...off, ...relay },
    listeners: counts.listeners ?? 0,
    relayViewers: counts.relayViewers ?? 0,
  };
}

describe("describeExposure", () => {
  it("is nothing at all with both roads off", () => {
    expect(describeExposure(status())).toBeNull();
  });

  it("lists both live roads with their own counts and stops both", () => {
    const view = describeExposure(
      status(
        { state: "running", url: "https://studio.ts.net" },
        { state: "running", url: "https://relay.example" },
        { listeners: 3, relayViewers: 2 },
      ),
    )!;
    expect(view.text).toBe("REMOTE");
    expect(view.tone).toBe("ok");
    expect(view.label).toContain(
      "Tailscale: reachable at https://studio.ts.net (1 connected).",
    );
    expect(view.label).toContain("Manor relay: reachable (2 connected).");
    expect(view.label).toContain("Click to stop both.");
    expect(view.stop).toEqual({ tunnel: true, relay: true });
  });

  it("names the relay when only the relay is live", () => {
    const view = describeExposure(
      status({}, { state: "running" }, { listeners: 1, relayViewers: 1 }),
    )!;
    expect(view.label).toBe(
      "Manor relay: reachable (1 connected). Click to stop.",
    );
    expect(view.stop).toEqual({ tunnel: false, relay: true });
  });

  it("goes amber, with the reason, while the relay cannot be reached", () => {
    const view = describeExposure(
      status(
        {},
        {
          state: "starting",
          error: "Relay connection lost (1006); reconnecting",
        },
      ),
    )!;
    expect(view.text).toBe("RETRYING");
    expect(view.tone).toBe("warning");
    expect(view.label).toContain("can't reach the relay, retrying");
    expect(view.label).toContain("1006");
    // Still trying to expose the machine, so a click stops it.
    expect(view.exposed).toBe(true);
    expect(view.stop.relay).toBe(true);
  });

  it("is plain STARTING while the relay is connecting for the first time", () => {
    const view = describeExposure(status({}, { state: "starting" }))!;
    expect(view.text).toBe("STARTING");
    expect(view.tone).toBe("ok");
  });

  it("goes red for a failed relay, and says which road failed", () => {
    const view = describeExposure(
      status({}, { state: "failed", error: "Another Manor took the room." }),
    )!;
    expect(view.text).toBe("RELAY FAILED");
    expect(view.tone).toBe("failed");
    expect(view.exposed).toBe(false);
    expect(view.label).toContain("Another Manor took the room.");
    expect(view.label).toContain("Click to dismiss.");
  });

  it("stays red while one road failed and the other is live", () => {
    const view = describeExposure(
      status(
        { state: "failed", error: "tailscale exited" },
        { state: "running" },
      ),
    )!;
    expect(view.text).toBe("REMOTE");
    expect(view.tone).toBe("failed");
    expect(view.label).toContain("Tailscale: tailscale exited");
  });
});
