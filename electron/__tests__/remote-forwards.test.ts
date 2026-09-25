import { describe, it, expect, vi, beforeEach } from "vitest";
import { RemoteForwards, resolveRemotePortUrl, type ForwardHosts } from "../remote-forwards";
import type { HostProvider, PortForward } from "../backend/providers/types";
import type { HostStatus, HostStatusInfo } from "../backend/registry";
import type { ActivePort } from "../backend/types";

/** A provider handing out forwards from 60000 up, honouring a free preferred port. */
function fakeProvider(opts: { taken?: Set<number> } = {}) {
  let next = 60000;
  const live = new Map<number, number>(); // localPort -> remotePort
  const calls: { remotePort: number; preferredLocalPort?: number }[] = [];
  let fail: Error | null = null;
  let hold: Promise<void> | null = null;
  const provider = {
    kind: "ssh" as const,
    capabilities: { autoSleep: false, persistsMemory: false, previewUrls: false },
    ensureUp: async () => {},
    status: async () => "up" as const,
    transport: () => {
      throw new Error("not used");
    },
    dispose: async () => {},
    async forwardPort(
      remotePort: number,
      o?: { preferredLocalPort?: number },
    ): Promise<PortForward> {
      calls.push({ remotePort, preferredLocalPort: o?.preferredLocalPort });
      if (hold) await hold;
      if (fail) throw fail;
      const preferred = o?.preferredLocalPort;
      const localPort =
        preferred !== undefined && !live.has(preferred) && !opts.taken?.has(preferred)
          ? preferred
          : next++;
      live.set(localPort, remotePort);
      return { localPort, dispose: () => live.delete(localPort) };
    },
  } satisfies HostProvider;
  return {
    provider,
    live,
    calls,
    failWith: (err: Error | null) => {
      fail = err;
    },
    holdUntil: (p: Promise<void> | null) => {
      hold = p;
    },
  };
}

/** A registry of remote hosts whose status tests drive by hand. */
function fakeRegistry() {
  const hosts = new Map<string, { status: HostStatus; provider: HostProvider }>();
  const listeners = new Set<(hosts: HostStatusInfo[]) => void>();
  const emit = () => {
    const list = Array.from(hosts, ([hostId, h]) => ({
      hostId,
      spec: null,
      status: h.status,
    }));
    for (const l of listeners) l(list);
  };
  const registry: ForwardHosts = {
    provider: (hostId) => hosts.get(hostId)?.provider,
    status: (hostId) => hosts.get(hostId)?.status,
    onStatusChange: (handler) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
  };
  return {
    registry,
    set(hostId: string, status: HostStatus, provider?: HostProvider) {
      const existing = hosts.get(hostId);
      hosts.set(hostId, { status, provider: provider ?? existing!.provider });
      emit();
    },
    remove(hostId: string) {
      hosts.delete(hostId);
      emit();
    },
    listenerCount: () => listeners.size,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("RemoteForwards", () => {
  let reg: ReturnType<typeof fakeRegistry>;
  let box: ReturnType<typeof fakeProvider>;
  let forwards: RemoteForwards;

  beforeEach(() => {
    reg = fakeRegistry();
    box = fakeProvider();
    reg.set("box", "connected", box.provider);
    forwards = new RemoteForwards(reg.registry);
  });

  it("creates a forward once per (host, port) and caches it", async () => {
    expect(forwards.localPort("box", 3000)).toBeUndefined();
    const [a, b] = await Promise.all([forwards.ensure("box", 3000), forwards.ensure("box", 3000)]);
    expect(a).toBe(60000);
    expect(b).toBe(60000);
    expect(await forwards.ensure("box", 3000)).toBe(60000);
    expect(box.calls).toHaveLength(1);
    expect(forwards.localPort("box", 3000)).toBe(60000);
    expect(await forwards.ensure("box", 4000)).toBe(60001);
  });

  it("announces forwards appearing and going away", async () => {
    const onChange = vi.fn();
    forwards.onChange(onChange);
    await forwards.ensure("box", 3000);
    expect(onChange).toHaveBeenCalledTimes(1);
    reg.set("box", "reconnecting");
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("drops forwards on disconnect and recreates them on the same local port on reconnect", async () => {
    await forwards.ensure("box", 3000);
    await forwards.ensure("box", 4000);

    reg.set("box", "reconnecting");
    expect(box.live.size).toBe(0);
    expect(forwards.localPort("box", 3000)).toBeUndefined();

    reg.set("box", "connected");
    await flush();
    expect(forwards.localPort("box", 3000)).toBe(60000);
    expect(forwards.localPort("box", 4000)).toBe(60001);
    expect(box.calls.slice(2)).toEqual([
      { remotePort: 3000, preferredLocalPort: 60000 },
      { remotePort: 4000, preferredLocalPort: 60001 },
    ]);
  });

  it("takes another local port when the old one was taken meanwhile", async () => {
    const taken = new Set<number>();
    const box2 = fakeProvider({ taken });
    reg.set("box2", "connected", box2.provider);
    await forwards.ensure("box2", 3000);
    reg.set("box2", "disconnected");
    taken.add(60000);
    reg.set("box2", "connected");
    await flush();
    expect(forwards.localPort("box2", 3000)).toBe(60001);
  });

  it("rejects while the host is not connected, then forwards once it is", async () => {
    reg.set("box", "connecting");
    await expect(forwards.ensure("box", 3000)).rejects.toThrow(/not connected/);
    expect(box.calls).toHaveLength(0);

    reg.set("box", "connected");
    await flush();
    expect(forwards.localPort("box", 3000)).toBe(60000);
  });

  it("disposes a forward that lands after its host went away", async () => {
    let release!: () => void;
    box.holdUntil(new Promise<void>((r) => (release = r)));
    const pending = forwards.ensure("box", 3000);
    reg.set("box", "disconnected");
    box.holdUntil(null);
    release();
    await expect(pending).rejects.toThrow(/cancelled/);
    expect(box.live.size).toBe(0);
    expect(forwards.localPort("box", 3000)).toBeUndefined();
  });

  it("forgets an unregistered host's forwards for good", async () => {
    await forwards.ensure("box", 3000);
    reg.remove("box");
    expect(box.live.size).toBe(0);
    reg.set("box", "connected", box.provider);
    await flush();
    expect(forwards.localPort("box", 3000)).toBeUndefined();
    expect(box.calls).toHaveLength(1);
  });

  it("recreates forwards on a replaced host's new provider", async () => {
    await forwards.ensure("box", 3000);
    const replacement = fakeProvider();
    reg.set("box", "connected", replacement.provider);
    await flush();
    expect(box.live.size).toBe(0);
    expect(replacement.calls).toEqual([{ remotePort: 3000, preferredLocalPort: 60000 }]);
    expect(forwards.localPort("box", 3000)).toBe(60000);
  });

  it("logs, and retries on the next connect, when recreating fails", async () => {
    await forwards.ensure("box", 3000);
    reg.set("box", "reconnecting");
    box.failWith(new Error("ssh said no"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    reg.set("box", "connected");
    await flush();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    expect(forwards.localPort("box", 3000)).toBeUndefined();

    box.failWith(null);
    reg.set("box", "reconnecting");
    reg.set("box", "connected");
    await flush();
    expect(forwards.localPort("box", 3000)).toBe(60000);
  });

  it("dispose drops every forward and stops listening", async () => {
    await forwards.ensure("box", 3000);
    forwards.dispose();
    expect(box.live.size).toBe(0);
    expect(reg.listenerCount()).toBe(0);
  });
});

describe("resolveRemotePortUrl", () => {
  const port = (p: number, hostname: string | null = null): ActivePort => ({
    port: p,
    processName: "node",
    pid: 1,
    workspacePath: "/w",
    hostname,
    hostId: "box",
  });
  const remote = [port(3000), port(5173, "web.acme.localhost:1355")];
  const ensure = vi.fn(async (p: number) => 40000 + p);

  beforeEach(() => ensure.mockClear());

  it("rewrites loopback URLs of reported ports, keeping path, query and hash", async () => {
    expect(await resolveRemotePortUrl("http://localhost:3000/a/b?q=1#h", remote, ensure)).toBe(
      "http://localhost:43000/a/b?q=1#h",
    );
    expect(await resolveRemotePortUrl("http://127.0.0.1:3000", remote, ensure)).toBe(
      "http://127.0.0.1:43000/",
    );
    expect(await resolveRemotePortUrl("http://[::1]:3000/", remote, ensure)).toBe(
      "http://[::1]:43000/",
    );
  });

  it("leaves ports the scan did not report alone", async () => {
    expect(await resolveRemotePortUrl("http://localhost:8080/", remote, ensure)).toBe(
      "http://localhost:8080/",
    );
    // No explicit port means 80, which nobody reported.
    expect(await resolveRemotePortUrl("http://localhost/", remote, ensure)).toBe(
      "http://localhost/",
    );
    expect(ensure).not.toHaveBeenCalled();
  });

  it("leaves non-loopback and non-http URLs alone", async () => {
    for (const url of [
      "https://example.com:3000/",
      "file:///tmp/x.html",
      "about:blank",
      "not a url",
    ]) {
      expect(await resolveRemotePortUrl(url, remote, ensure)).toBe(url);
    }
    expect(ensure).not.toHaveBeenCalled();
  });

  it("keeps a portless URL but makes the forward behind its route", async () => {
    expect(
      await resolveRemotePortUrl("http://web.acme.localhost:1355/x", remote, ensure),
    ).toBe("http://web.acme.localhost:1355/x");
    expect(ensure).toHaveBeenCalledWith(5173);
  });

  it("propagates a forward failure", async () => {
    await expect(
      resolveRemotePortUrl("http://localhost:3000/", remote, async () => {
        throw new Error("down");
      }),
    ).rejects.toThrow("down");
  });
});
