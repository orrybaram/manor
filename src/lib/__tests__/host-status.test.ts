import { describe, it, expect } from "vitest";
import {
  describeHostOffline,
  describeHostStatus,
  isPaneInputBlocked,
  secondsUntilRetry,
} from "../host-status";
import type { HostStatusInfo } from "../../store/host-store";

function host(overrides: Partial<HostStatusInfo>): HostStatusInfo {
  return {
    hostId: "box",
    spec: { kind: "ssh", target: "me@box" },
    status: "disconnected",
    ...overrides,
  };
}

describe("describeHostStatus", () => {
  it("shows a plain connected state with no warnings", () => {
    const display = describeHostStatus(host({ status: "connected" }));
    expect(display).toEqual({ label: "Connected", tone: "ok" });
  });

  it("surfaces bootstrap warnings on an otherwise-connected host", () => {
    const display = describeHostStatus(
      host({ status: "connected", warnings: ["skipped an unparseable agent config"] }),
    );
    expect(display.label).toBe("Connected");
    expect(display.tone).toBe("warn");
    expect(display.detail).toContain("unparseable agent config");
  });

  it("shows bootstrap progress while connecting", () => {
    const display = describeHostStatus(
      host({ status: "connecting", progress: "Installing manor-host…" }),
    );
    expect(display.tone).toBe("pending");
    expect(display.detail).toBe("Installing manor-host…");
  });

  it("shows a retry countdown while reconnecting", () => {
    const display = describeHostStatus(
      host({ status: "reconnecting", retryInMs: 4000 }),
    );
    expect(display.tone).toBe("pending");
    expect(display.detail).toBe("Retrying in 4s");
  });

  it("distinguishes an auth failure from a generic error, with the ssh-add hint intact", () => {
    const display = describeHostStatus(
      host({
        status: "error",
        error: "ssh could not authenticate to me@box. … `ssh-add` …",
        failure: {
          reason: "auth",
          message: "ssh could not authenticate to me@box. … `ssh-add` …",
        },
      }),
    );
    expect(display.label).toBe("Authentication failed");
    expect(display.tone).toBe("error");
    expect(display.detail).toContain("ssh-add");
  });

  it("distinguishes a host-key failure", () => {
    const display = describeHostStatus(
      host({
        status: "error",
        error: "me@box's host key is not trusted yet.",
        failure: { reason: "host-key", message: "me@box's host key is not trusted yet." },
      }),
    );
    expect(display.label).toBe("Host key not trusted");
  });

  it("distinguishes a bootstrap failure and keeps its code-specific hint", () => {
    const display = describeHostStatus(
      host({
        status: "error",
        error: "Build it with `node scripts/build-host-tarball.mjs`.",
        failure: {
          reason: "bootstrap",
          code: "tarball-missing",
          message: "Build it with `node scripts/build-host-tarball.mjs`.",
        },
      }),
    );
    expect(display.label).toBe("Could not set up the remote host");
    expect(display.detail).toContain("build-host-tarball.mjs");
  });

  it("falls back to a generic label for an error with no classified failure", () => {
    const display = describeHostStatus(
      host({ status: "error", error: "something else went wrong" }),
    );
    expect(display.label).toBe("Connection failed");
  });

  it("shows disconnected for a host nobody has connected yet", () => {
    const display = describeHostStatus(host({ status: "disconnected" }));
    expect(display).toEqual({ label: "Disconnected", tone: "pending" });
  });
});

describe("describeHostOffline (ADR-178 §6)", () => {
  it("shows nothing for a connected or unknown host", () => {
    expect(describeHostOffline(host({ status: "connected" }))).toBeNull();
    expect(describeHostOffline(undefined)).toBeNull();
  });

  it("reads a routine drop as reconnecting, retryable", () => {
    expect(describeHostOffline(host({ status: "reconnecting" }))).toEqual({
      badge: "Disconnected — reconnecting",
      banner: "Disconnected from me@box — reconnecting",
      canRetry: true,
    });
  });

  it("offers no retry while a connect is already running", () => {
    expect(describeHostOffline(host({ status: "connecting" }))?.canRetry).toBe(false);
  });

  it("names a failure and carries its actionable message", () => {
    const display = describeHostOffline(
      host({ status: "error", error: "run ssh-add", failure: { reason: "auth", message: "run ssh-add" } }),
    );
    expect(display).toMatchObject({
      badge: "Disconnected",
      banner: "Authentication failed — me@box",
      detail: "run ssh-add",
      canRetry: true,
    });
  });
});

describe("secondsUntilRetry", () => {
  it("counts down to the next attempt while reconnecting", () => {
    const h = host({ status: "reconnecting", retryInMs: 8000, retryAt: 10_000 });
    expect(secondsUntilRetry(h, 2_000)).toBe(8);
    expect(secondsUntilRetry(h, 9_100)).toBe(1);
    expect(secondsUntilRetry(h, 12_000)).toBe(0);
  });

  it("is null without a scheduled attempt", () => {
    expect(secondsUntilRetry(host({ status: "reconnecting" }), 0)).toBeNull();
    expect(secondsUntilRetry(host({ status: "error", retryAt: 5 }), 0)).toBeNull();
  });
});

describe("isPaneInputBlocked", () => {
  const hosts = [host({ status: "reconnecting" }), host({ hostId: "up", status: "connected" })];

  it("drops input for a pane whose remote host is away", () => {
    expect(isPaneInputBlocked("p1", { p1: "box" }, hosts)).toBe(true);
  });

  it("lets input through for local panes, connected hosts and unreported hosts", () => {
    expect(isPaneInputBlocked("p1", {}, hosts)).toBe(false);
    expect(isPaneInputBlocked("p1", { p1: "up" }, hosts)).toBe(false);
    expect(isPaneInputBlocked("p1", { p1: "unknown" }, hosts)).toBe(false);
  });
});
