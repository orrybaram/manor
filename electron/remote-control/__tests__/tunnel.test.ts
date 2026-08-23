/**
 * The tunnel is the step that makes a loopback listener reachable from the
 * internet, so the tests are about the lifecycle rather than the spawn: it
 * must never claim "running" when it is not, must never leave a child behind,
 * and must prefer Tailscale when it can.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { TunnelManager, type TunnelChild, type TunnelStatus } from "../tunnel";

/** A `ChildProcess` stand-in that never touches a real binary. */
class FakeChild extends EventEmitter implements TunnelChild {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed: NodeJS.Signals[] = [];
  /** When false, SIGTERM is ignored — the stubborn-child case. */
  constructor(private readonly diesOnTerm = true) {
    super();
  }
  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killed.push(signal);
    if (signal === "SIGKILL" || this.diesOnTerm) this.exit(0);
    return true;
  }
  exit(code: number | null): void {
    this.emit("exit", code);
  }
}

const CLOUDFLARE_BANNER = `
2026-08-23T00:00:00Z INF +--------------------------------------------+
2026-08-23T00:00:00Z INF |  https://calm-forest-pine-echo.trycloudflare.com  |
2026-08-23T00:00:00Z INF +--------------------------------------------+
`;

const TAILSCALE_BANNER = `
Available within your tailnet:

https://studio.tail1234.ts.net/
`;

function manager(
  which: (bin: string) => Promise<string | null>,
  child?: FakeChild,
) {
  const spawned: Array<{ command: string; args: string[] }> = [];
  const mgr = new TunnelManager({
    which,
    spawn: (command, args) => {
      spawned.push({ command, args });
      return child ?? new FakeChild();
    },
  });
  return { mgr, spawned };
}

const hasAll = async () => "/usr/local/bin/x";
const hasNone = async () => null;

describe("detection", () => {
  it("reports what is on PATH", async () => {
    const { mgr } = manager(async (bin) =>
      bin === "cloudflared" ? "/usr/local/bin/cloudflared" : null,
    );
    expect(await mgr.detect()).toEqual({
      tailscale: false,
      cloudflared: true,
    });
  });

  it("prefers tailscale when both are present", async () => {
    const { mgr } = manager(hasAll);
    expect(await mgr.preferredKind()).toBe("tailscale");
  });

  it("falls back to cloudflared", async () => {
    const { mgr } = manager(async (bin) =>
      bin === "cloudflared" ? "/x" : null,
    );
    expect(await mgr.preferredKind()).toBe("cloudflared");
  });

  it("reports nothing available", async () => {
    const { mgr } = manager(hasNone);
    expect(await mgr.preferredKind()).toBeNull();
  });
});

describe("start", () => {
  let child: FakeChild;

  beforeEach(() => {
    child = new FakeChild();
  });

  it("parses a cloudflared quick-tunnel URL off stderr", async () => {
    const { mgr, spawned } = manager(hasAll, child);
    const started = mgr.start("cloudflared", 4321);
    child.stderr.write(CLOUDFLARE_BANNER);
    await expect(started).resolves.toEqual({
      url: "https://calm-forest-pine-echo.trycloudflare.com",
    });
    expect(spawned[0]).toEqual({
      command: "cloudflared",
      args: ["tunnel", "--url", "http://127.0.0.1:4321"],
    });
    expect(mgr.status).toMatchObject({ state: "running", kind: "cloudflared" });
  });

  it("parses a tailscale serve URL and drops the trailing slash", async () => {
    const { mgr, spawned } = manager(hasAll, child);
    const started = mgr.start("tailscale", 4321);
    child.stdout.write(TAILSCALE_BANNER);
    await expect(started).resolves.toEqual({
      url: "https://studio.tail1234.ts.net",
    });
    expect(spawned[0].args).toEqual([
      "serve",
      "--https=443",
      "http://127.0.0.1:4321",
    ]);
  });

  it("finds a URL split across chunks", async () => {
    const { mgr } = manager(hasAll, child);
    const started = mgr.start("cloudflared", 1);
    child.stderr.write("INF |  https://calm-forest");
    child.stderr.write("-pine-echo.trycloudflare.com  |");
    await expect(started).resolves.toEqual({
      url: "https://calm-forest-pine-echo.trycloudflare.com",
    });
  });

  it("goes through starting on the way to running", async () => {
    const { mgr } = manager(hasAll, child);
    const seen: TunnelStatus[] = [];
    mgr.onStatus((s) => seen.push(s));
    const started = mgr.start("cloudflared", 1);
    expect(mgr.status.state).toBe("starting");
    child.stderr.write(CLOUDFLARE_BANNER);
    await started;
    expect(seen.map((s) => s.state)).toEqual(["starting", "running"]);
  });

  it("kills the child and fails when no URL arrives in time", async () => {
    vi.useFakeTimers();
    try {
      const { mgr } = manager(hasAll, child);
      const started = mgr.start("cloudflared", 1);
      const caught = started.catch((err: Error) => err.message);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await caught).toContain("did not report a URL");
      expect(child.killed).toContain("SIGTERM");
      expect(mgr.status.state).toBe("failed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails when the child exits before reporting a URL", async () => {
    const { mgr } = manager(hasAll, child);
    const started = mgr.start("cloudflared", 1);
    const caught = started.catch((err: Error) => err.message);
    child.exit(1);
    expect(await caught).toContain("exited before reporting a URL");
    expect(mgr.status.state).toBe("failed");
  });

  it("fails when the binary cannot be spawned", async () => {
    const mgr = new TunnelManager({
      which: hasAll,
      spawn: () => {
        throw new Error("ENOENT");
      },
    });
    await expect(mgr.start("cloudflared", 1)).rejects.toThrow("ENOENT");
    expect(mgr.status.state).toBe("failed");
  });

  it("reports failed when a running child dies on its own", async () => {
    const { mgr } = manager(hasAll, child);
    const started = mgr.start("cloudflared", 1);
    child.stderr.write(CLOUDFLARE_BANNER);
    await started;

    child.exit(137);
    expect(mgr.status).toMatchObject({
      state: "failed",
      url: null,
    });
    expect(mgr.status.error).toContain("exited unexpectedly");
  });
});

describe("stop", () => {
  it("kills the child and reports stopped", async () => {
    const child = new FakeChild();
    const { mgr } = manager(hasAll, child);
    const started = mgr.start("cloudflared", 1);
    child.stderr.write(CLOUDFLARE_BANNER);
    await started;

    await mgr.stop();
    expect(child.killed).toEqual(["SIGTERM"]);
    expect(mgr.status).toEqual({
      state: "stopped",
      kind: null,
      url: null,
      error: null,
    });
  });

  it("does not report failed for a child we killed on purpose", async () => {
    const child = new FakeChild();
    const { mgr } = manager(hasAll, child);
    const started = mgr.start("cloudflared", 1);
    child.stderr.write(CLOUDFLARE_BANNER);
    await started;

    const seen: TunnelStatus[] = [];
    mgr.onStatus((s) => seen.push(s));
    await mgr.stop();
    expect(seen.map((s) => s.state)).toEqual(["stopped"]);
  });

  it("escalates to SIGKILL when SIGTERM is ignored", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild(false);
      const { mgr } = manager(hasAll, child);
      const started = mgr.start("cloudflared", 1);
      child.stderr.write(CLOUDFLARE_BANNER);
      await started;

      const stopped = mgr.stop();
      await vi.advanceTimersByTimeAsync(6_000);
      await stopped;
      expect(child.killed).toEqual(["SIGTERM", "SIGKILL"]);
      expect(mgr.status.state).toBe("stopped");
    } finally {
      vi.useRealTimers();
    }
  });

  it("is idempotent and safe before any start", async () => {
    const { mgr } = manager(hasAll);
    await mgr.stop();
    await mgr.stop();
    expect(mgr.status.state).toBe("stopped");
  });

  it("unsubscribes a status listener", async () => {
    const { mgr } = manager(hasAll);
    const seen: TunnelStatus[] = [];
    const off = mgr.onStatus((s) => seen.push(s));
    off();
    await mgr.stop();
    expect(seen).toEqual([]);
  });
});
