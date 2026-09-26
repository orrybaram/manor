import { describe, it, expect } from "vitest";
import {
  describeHost,
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

describe("describeHost", () => {
  it("is undefined for a host main hasn't reported", () => {
    expect(describeHost(undefined, 0)).toBeUndefined();
  });

  it("shows a plain connected state by its target", () => {
    expect(describeHost(host({ status: "connected" }), 0)).toMatchObject({
      target: "me@box",
      offline: false,
      tone: "ok",
      status: "Connected",
      canRetry: false,
    });
  });

  it("surfaces bootstrap warnings on an otherwise-connected host", () => {
    const d = describeHost(
      host({ status: "connected", warnings: ["skipped an unparseable agent config"] }),
      0,
    )!;
    expect(d.offline).toBe(false);
    expect(d.tone).toBe("warn");
    expect(d.detail).toContain("unparseable agent config");
  });

  it("shows connecting as busy, with progress and no retry", () => {
    expect(
      describeHost(host({ status: "connecting", progress: "Installing manor-host…" }), 0),
    ).toMatchObject({
      offline: true,
      busy: true,
      tone: "warn",
      banner: "Connecting to me@box…",
      detail: "Installing manor-host…",
      canRetry: false,
    });
  });

  it("reads a routine drop as reconnecting with a countdown, retryable", () => {
    const h = host({ status: "reconnecting", retryInMs: 4000, retryAt: 10_000 });
    expect(describeHost(h, 6_000)).toMatchObject({
      tone: "warn",
      status: "Reconnecting in 4s",
      banner: "Reconnecting to me@box in 4s",
      canRetry: true,
    });
    expect(describeHost(host({ status: "reconnecting" }), 0)?.status).toBe("Reconnecting…");
  });

  it("distinguishes an auth failure, with the ssh-add hint intact", () => {
    const d = describeHost(
      host({
        status: "error",
        error: "ssh could not authenticate to me@box. … `ssh-add` …",
        failure: { reason: "auth", message: "ssh could not authenticate to me@box. … `ssh-add` …" },
      }),
      0,
    )!;
    expect(d.status).toBe("Authentication failed");
    expect(d.banner).toBe("Can't connect to me@box: authentication failed");
    expect(d.tone).toBe("error");
    expect(d.detail).toContain("ssh-add");
    expect(d.canRetry).toBe(true);
  });

  it("distinguishes host-key and bootstrap failures", () => {
    expect(
      describeHost(host({ status: "error", failure: { reason: "host-key", message: "x" } }), 0)
        ?.status,
    ).toBe("Host key not trusted");
    const d = describeHost(
      host({
        status: "error",
        error: "Build it with `node scripts/build-host-tarball.mjs`.",
        failure: { reason: "bootstrap", code: "tarball-missing", message: "x" },
      }),
      0,
    )!;
    expect(d.status).toBe("Couldn't set up the remote host");
    expect(d.detail).toContain("build-host-tarball.mjs");
  });

  it("falls back to a generic label for an unclassified error", () => {
    expect(
      describeHost(host({ status: "error", error: "something else went wrong" }), 0),
    ).toMatchObject({ status: "Can't connect", banner: "Can't connect to me@box" });
  });

  it("shows disconnected for a host nobody has connected yet", () => {
    expect(describeHost(host({ status: "disconnected" }), 0)).toMatchObject({
      offline: true,
      status: "Disconnected",
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
