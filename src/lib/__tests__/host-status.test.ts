import { describe, it, expect } from "vitest";
import { describeHostStatus } from "../host-status";
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
