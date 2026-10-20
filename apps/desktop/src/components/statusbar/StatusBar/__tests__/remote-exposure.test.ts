import { describe, expect, it } from "vitest";

import type { RelayStatus } from "../../../../electron.d";
import { describeExposure } from "../remote-exposure";

const off = { state: "stopped", url: null, error: null } as const;

function status(relay: Partial<RelayStatus> = {}, relayViewers = 0) {
  return { relay: { ...off, ...relay }, relayViewers };
}

describe("describeExposure", () => {
  it("is nothing at all with the relay off", () => {
    expect(describeExposure(status())).toBeNull();
  });

  it("names the relay and its viewers while it is live", () => {
    const view = describeExposure(
      status({ state: "running", url: "https://relay.example" }, 2),
    )!;
    expect(view.text).toBe("remote");
    expect(view.tone).toBe("ok");
    expect(view.label).toBe(
      "Manor relay: reachable (2 connected).",
    );
  });

  it("goes amber, with the reason, while the relay cannot be reached", () => {
    const view = describeExposure(
      status({
        state: "starting",
        error: "Relay connection lost (1006); reconnecting",
      }),
    )!;
    expect(view.text).toBe("retrying");
    expect(view.tone).toBe("warning");
    expect(view.label).toContain("can't reach the relay, retrying");
    expect(view.label).toContain("1006");
  });

  it("is plain connecting while the relay is connecting for the first time", () => {
    const view = describeExposure(status({ state: "starting" }))!;
    expect(view.text).toBe("connecting");
    expect(view.tone).toBe("ok");
  });

  it("goes red for a failed relay", () => {
    const view = describeExposure(
      status({ state: "failed", error: "Another Manor took the room." }),
    )!;
    expect(view.text).toBe("relay failed");
    expect(view.tone).toBe("failed");
    expect(view.label).toContain("Another Manor took the room.");
  });
});
