/**
 * A desktop window's host servers (ADR-228 D3, D4, `../desktop-hosts.ts`):
 * which hosts get a bridge of the window's own, and when they leave.
 */

import { describe, expect, it, vi } from "vitest";

import type { HostStatusInfo } from "../../store/host-store";
import type { BridgeTransport } from "../client";
import { watchDesktopHosts } from "../desktop-hosts";
import { createServerSet } from "../server-set";
import type { HostPipeApi } from "../transports/host-pipe";
import type { WsBridgeTransport } from "../transports/ws";

function homeTransport(): BridgeTransport {
  return {
    start() {},
    rendererId: "1",
    platform: "electron",
    rootValues: {},
    localNamespaces: {},
    locallyServed: {},
    invoke: () => Promise.resolve(null),
    subscribe: () => () => {},
  };
}

function fakeTransport() {
  const probeNow = vi.fn<WsBridgeTransport["probeNow"]>(() => Promise.resolve("redialing"));
  const close = vi.fn<WsBridgeTransport["close"]>();
  const transport: WsBridgeTransport = {
    ...homeTransport(),
    platform: "web",
    probeNow,
    close,
  };
  return Object.assign(transport, { probeNow, close });
}

function host(hostId: string, overrides: Partial<HostStatusInfo> = {}): HostStatusInfo {
  return {
    hostId,
    spec: { kind: "ssh", target: hostId },
    status: "connected",
    viewerBridge: true,
    ...overrides,
  };
}

function setup(initial: HostStatusInfo[]) {
  const set = createServerSet();
  set.add("local", homeTransport(), { home: true, lists: "all" });
  let push: (hosts: HostStatusInfo[]) => void = () => {};
  const made = new Map<string, ReturnType<typeof fakeTransport>>();
  const stop = watchDesktopHosts({
    set,
    pipes: {} as HostPipeApi,
    hosts: {
      list: () => Promise.resolve(initial),
      onStatusChanged: (cb) => {
        push = cb;
        return () => {};
      },
    },
    transport: (hostId) => {
      const transport = fakeTransport();
      made.set(hostId, transport);
      return transport;
    },
  });
  return { set, made, stop, push: (hosts: HostStatusInfo[]) => push(hosts) };
}

const ids = (set: ReturnType<typeof createServerSet>) => set.list().map((entry) => entry.id);

describe("a desktop window's host servers", () => {
  it("adds a connected host whose server takes a viewer stream, and only that", async () => {
    const { set } = setup([
      { hostId: "local", spec: null, status: "connected" },
      host("box"),
      // An older server, one not read yet, and one away: main's (D3).
      host("old", { viewerBridge: false }),
      host("fresh", { viewerBridge: undefined }),
      host("asleep", { status: "reconnecting" }),
    ]);
    await vi.waitFor(() => expect(ids(set)).toEqual(["local", "box"]));
    expect(set.get("box")?.hello.capabilities).toEqual(["viewer-bridge"]);
  });

  it("adds a host once its first status says it takes a viewer stream", async () => {
    const { set, push } = setup([host("box", { viewerBridge: undefined })]);
    await Promise.resolve();
    expect(ids(set)).toEqual(["local"]);
    push([host("box")]);
    expect(ids(set)).toEqual(["local", "box"]);
  });

  it("keeps an away host, and dials it at once when it is back", async () => {
    const { set, made, push } = setup([host("box")]);
    await vi.waitFor(() => expect(ids(set)).toEqual(["local", "box"]));
    push([host("box", { status: "reconnecting" })]);
    expect(ids(set)).toEqual(["local", "box"]);
    set.setReachability("box", "unreachable");

    push([host("box")]);
    expect(made.get("box")?.probeNow).toHaveBeenCalledOnce();
    expect(made.get("box")?.close).not.toHaveBeenCalled();
  });

  it("removes a host that is removed or no longer takes a viewer stream, and stops its transport", async () => {
    const { set, made, push, stop } = setup([host("box"), host("pi")]);
    await vi.waitFor(() => expect(ids(set)).toEqual(["local", "box", "pi"]));

    push([host("box", { viewerBridge: false }), host("pi")]);
    expect(ids(set)).toEqual(["local", "pi"]);
    expect(made.get("box")?.close).toHaveBeenCalledOnce();

    push([]);
    expect(ids(set)).toEqual(["local"]);
    expect(made.get("pi")?.close).toHaveBeenCalledOnce();

    push([host("pi")]);
    expect(ids(set)).toEqual(["local", "pi"]);
    stop();
    expect(ids(set)).toEqual(["local"]);
  });
});
