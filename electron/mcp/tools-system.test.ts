import { describe, it, expect } from "vitest";
import { systemModule } from "./tools-system";
import type { Http } from "./types";

const base = {
  enabled: true,
  port: 4177,
  devices: [{ id: "d1", label: "phone" }],
  listeners: 2,
};

function httpReturning(status: unknown): Http {
  return {
    get: async () => status,
    post: async () => status,
    del: async () => status,
  };
}

async function run(tool: string, status: unknown): Promise<string> {
  const result = await systemModule.handlers[tool]({}, httpReturning(status));
  return JSON.stringify(result);
}

describe("remote-control tools report the relay (ADR-206)", () => {
  it("says the relay is running, and how many came through it", async () => {
    const out = await run("remote_control_status", {
      ...base,
      relay: { state: "running", url: "https://relay.example", error: null },
      relayViewers: 1,
    });
    expect(out).toContain("Relay: running — https://relay.example");
    expect(out).toContain("Live listeners: 2 (1 through the relay)");
  });

  it("does not call the machine loopback-only after a disable while the relay runs", async () => {
    const out = await run("set_remote_control_enabled", {
      ...base,
      relay: { state: "running", url: "https://relay.example", error: null },
      relayViewers: 0,
    });
    expect(out).toContain("Relay: running");
    expect(out).not.toContain("Tunnel");
    expect(out).not.toContain("Tailscale");
  });

  it("names a relay it cannot reach rather than calling it starting", async () => {
    const out = await run("remote_control_status", {
      ...base,
      relay: {
        state: "starting",
        url: null,
        error: "Relay connection lost (1006); reconnecting",
      },
    });
    expect(out).toContain("Relay: can't reach the relay, retrying — Relay");
  });
});
