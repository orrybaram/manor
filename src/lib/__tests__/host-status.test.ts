import { describe, it, expect } from "vitest";
import {
  describeHost,
  groupHostState,
  isHostOffline,
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
      banner: "Lost connection to me@box. Reconnecting in 4s",
      summary: "Lost the connection. Reconnecting in 4s",
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
    expect(d.status).toBe("Auth failed");
    expect(d.banner).toBe("me@box rejected your ssh key");
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
    expect(d.status).toBe("Setup failed");
    expect(d.detail).toContain("build-host-tarball.mjs");
  });

  it("falls back to a generic label for an unclassified error", () => {
    expect(
      describeHost(host({ status: "error", error: "something else went wrong" }), 0),
    ).toMatchObject({ status: "Connection failed", banner: "Connection to me@box failed" });
  });

  it("labels ssh failing to reach the host as unreachable, in plain words", () => {
    const d = describeHost(
      host({
        status: "error",
        error:
          "ssh to blade failed while bootstrapping (exit 255 running `uname -sm`): " +
          "ssh: connect to host 192.168.1.175 port 2222: Host is down",
      }),
      0,
    )!;
    expect(d.status).toBe("Unreachable");
    expect(d.banner).toBe("me@box isn't responding");
    expect(d.tone).toBe("error");
    expect(d.summary).toBe(
      "Nothing answered at 192.168.1.175:2222. Check it's awake and on your network.",
    );
    expect(d.detail).toContain("exit 255");
    expect(d.canRetry).toBe(true);
  });

  it("tells a refused connection and an unknown hostname apart", () => {
    expect(
      describeHost(
        host({ status: "error", error: "ssh: connect to host box port 22: Connection refused" }),
        0,
      )?.summary,
    ).toBe("box:22 refused the connection. Check sshd is running on that port.");
    expect(
      describeHost(
        host({
          status: "error",
          error: "ssh: Could not resolve hostname nope: nodename nor servname provided",
        }),
        0,
      )?.summary,
    ).toBe("Couldn't find nope. Check the hostname or your ssh config.");
  });

  it("gives a classified failure a summary of its own", () => {
    expect(
      describeHost(host({ status: "error", failure: { reason: "auth", message: "x" } }), 0)
        ?.summary,
    ).toBe("ssh couldn't log in with your keys.");
  });

  it("shows disconnected for a host nobody has connected yet", () => {
    expect(describeHost(host({ status: "disconnected" }), 0)).toMatchObject({
      offline: true,
      status: "Not connected",
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

describe("isHostOffline", () => {
  const hosts = [
    host({ status: "error" }),
    host({ hostId: "up", status: "connected" }),
    host({ hostId: "local", spec: null, status: "connected" }),
  ];

  it("is true only for a reported remote host that is not connected", () => {
    expect(isHostOffline("box", hosts)).toBe(true);
    expect(isHostOffline("up", hosts)).toBe(false);
    expect(isHostOffline("local", hosts)).toBe(false);
  });

  it("counts a host still connecting or reconnecting as away", () => {
    const pending = [
      host({ hostId: "a", status: "connecting" }),
      host({ hostId: "b", status: "reconnecting" }),
    ];
    expect(isHostOffline("a", pending)).toBe(true);
    expect(isHostOffline("b", pending)).toBe(true);
  });

  it("never marks this machine or an unreported host offline", () => {
    expect(isHostOffline(undefined, hosts)).toBe(false);
    expect(isHostOffline(null, hosts)).toBe(false);
    expect(isHostOffline("unknown", hosts)).toBe(false);
  });
});

describe("groupHostState", () => {
  const hosts = [
    host({ hostId: "box", status: "reconnecting" }),
    host({ hostId: "vm", status: "error" }),
    host({ hostId: "up", status: "connected" }),
  ];

  it("is connected when every member's host is up", () => {
    expect(groupHostState(["local", "up"], hosts)).toBe("connected");
    expect(groupHostState([undefined, "up"], hosts)).toBe("connected");
  });

  it("is offline when every member's host is away", () => {
    expect(groupHostState(["box", "vm"], hosts)).toBe("offline");
  });

  it("is partially offline when some but not all hosts are away", () => {
    expect(groupHostState(["local", "box"], hosts)).toBe("partially-offline");
    expect(groupHostState(["up", "box", "vm"], hosts)).toBe("partially-offline");
  });

  it("treats a connecting host as away and an unreported one as up", () => {
    const connecting = [host({ hostId: "box", status: "connecting" })];
    expect(groupHostState(["local", "box"], connecting)).toBe("partially-offline");
    expect(groupHostState(["local", "new"], connecting)).toBe("connected");
  });

  it("is connected for an empty member list", () => {
    expect(groupHostState([], hosts)).toBe("connected");
  });
});
