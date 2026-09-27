/**
 * DiffWatcher and PortScanner poll each host on its own, so a remote host
 * that never answers cannot stall local polling (ADR-160 ticket 9). Each
 * workspace comes with its host, and each host is asked through its own
 * backend (ADR-183).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import type { BrowserWindow } from "electron";
import { DiffWatcher } from "../diff-watcher";
import { PortScanner, RESCAN_MIN_MS } from "../ports";
import type { ActivePort, GitBackend, PortsBackend, ScannedPort } from "../backend/types";
import { HostUnavailableError } from "../backend/registry";
import type { HostBackends, HostPath } from "../per-host-poller";

/** Every host's backend, sharing `backend`'s git and ports. */
function hostsWith(backend: { git?: GitBackend; ports?: PortsBackend }): HostBackends {
  return { get: () => backend } as unknown as HostBackends;
}

/** A workspace under `/remote` is on "box"; any other is local. */
const ws = (path: string): HostPath => ({
  path,
  hostId: path.startsWith("/remote") ? "box" : "local",
});
const diffWs = (path: string) => ({ ...ws(path), defaultBranch: "main" });

function fakeWindow() {
  const send = vi.fn();
  return { window: { webContents: { send } } as unknown as BrowserWindow, send };
}

const never = () => new Promise<never>(() => {});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("DiffWatcher per host", () => {
  it("keeps emitting local stats while a remote host hangs", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    let added = 1;
    const git = {
      exec: vi.fn(async (cwd: string, args: string[]) => {
        if (cwd.startsWith("/remote")) return never();
        if (args[0] === "merge-base") return "abc\n";
        return ` 1 file changed, ${added} insertions(+)`;
      }),
    } as unknown as GitBackend;
    const watcher = new DiffWatcher(hostsWith({ git }));
    const { window, send } = fakeWindow();

    watcher.start(window, [diffWs("/local/app"), diffWs("/remote/app")]);
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith("diffs-changed", {
        "/local/app": { added: 1, removed: 0 },
      }),
    );

    added = 2;
    await vi.advanceTimersByTimeAsync(5000);
    expect(send).toHaveBeenLastCalledWith("diffs-changed", {
      "/local/app": { added: 2, removed: 0 },
    });
    // The remote scan from the first tick is still pending; no second one
    // was piled on top of it.
    const remoteMergeBases = vi
      .mocked(git.exec)
      .mock.calls.filter(([cwd, args]) => cwd === "/remote/app" && args[0] === "merge-base");
    expect(remoteMergeBases).toHaveLength(1);
    watcher.stop();
  });

  it("keeps a remote host's last stats, without logging, while it is unavailable", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let remoteUp = true;
    const git = {
      exec: vi.fn(async (cwd: string, args: string[]) => {
        if (cwd.startsWith("/remote") && !remoteUp) {
          throw new HostUnavailableError("box", "reconnecting");
        }
        if (args[0] === "merge-base") return "abc\n";
        return " 1 file changed, 4 insertions(+)";
      }),
    } as unknown as GitBackend;
    const watcher = new DiffWatcher(hostsWith({ git }));
    const { window, send } = fakeWindow();
    const both = {
      "/local/app": { added: 4, removed: 0 },
      "/remote/app": { added: 4, removed: 0 },
    };

    watcher.start(window, [diffWs("/local/app"), diffWs("/remote/app")]);
    await vi.waitFor(() => expect(send).toHaveBeenLastCalledWith("diffs-changed", both));

    remoteUp = false;
    send.mockClear();
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(5000);
    // The remote badge did not vanish, and the blip was not logged.
    expect(send).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
    watcher.stop();
  });

  it("runs each workspace's git on the host it names", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const gitOn = (removed: number) =>
      ({
        exec: vi.fn(async (_cwd: string, args: string[]) =>
          args[0] === "merge-base" ? "abc" : ` 1 file changed, ${removed} deletions(-)`,
        ),
      }) as unknown as GitBackend;
    const gits: Record<string, GitBackend> = { local: gitOn(3), box: gitOn(5) };
    const hosts = { get: (hostId: string) => ({ git: gits[hostId] }) } as unknown as HostBackends;
    const watcher = new DiffWatcher(hosts);
    const { window, send } = fakeWindow();
    // A remote workspace at a path that looks local: its host says otherwise.
    watcher.start(window, [
      { path: "/a", hostId: "local", defaultBranch: "main" },
      { path: "/b", hostId: "box", defaultBranch: "main" },
    ]);
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith("diffs-changed", {
        "/a": { added: 0, removed: 3 },
        "/b": { added: 0, removed: 5 },
      }),
    );
    expect(vi.mocked(gits.box.exec)).toHaveBeenCalledWith("/b", expect.anything());
    expect(vi.mocked(gits.local.exec)).not.toHaveBeenCalledWith("/b", expect.anything());
    watcher.stop();
  });
});

describe("PortScanner per host", () => {
  /** A port as a host's backend reports it. */
  const scanned = (pid: number, workspacePath: string): ScannedPort => ({
    port: 3000 + pid,
    processName: "node",
    pid,
    workspacePath,
    hostname: null,
  });
  /** The same port as the scanner publishes it: tagged with its host. */
  const port = (pid: number, workspacePath: string): ActivePort => ({
    ...scanned(pid, workspacePath),
    hostId: ws(workspacePath).hostId,
  });

  it("publishes local ports while a remote scan hangs", async () => {
    vi.useFakeTimers();
    let pid = 1;
    const ports = {
      scan: vi.fn(async (paths: string[]) => {
        if (paths.some((p) => p.startsWith("/remote"))) return never();
        return [scanned(pid, "/local/app")];
      }),
      kill: vi.fn(),
    } as unknown as PortsBackend;
    const scanner = new PortScanner(hostsWith({ ports }));
    scanner.updateWorkspaces([ws("/local/app"), ws("/remote/app")]);
    const { window, send } = fakeWindow();

    scanner.start(window);
    await vi.advanceTimersByTimeAsync(3000);
    expect(send).toHaveBeenLastCalledWith("ports-changed", [port(1, "/local/app")]);

    pid = 2;
    await vi.advanceTimersByTimeAsync(3000);
    expect(send).toHaveBeenLastCalledWith("ports-changed", [port(2, "/local/app")]);
    expect(vi.mocked(ports.scan)).toHaveBeenCalledWith(["/local/app"]);
    expect(
      vi.mocked(ports.scan).mock.calls.filter(([paths]) => paths[0] === "/remote/app"),
    ).toHaveLength(1);
    scanner.stop();
  });

  it("reports which hosts have been scanned, after the scan is published", async () => {
    vi.useFakeTimers();
    let remoteUp = false;
    const ports = {
      scan: vi.fn(async (paths: string[]) => {
        if (paths[0].startsWith("/remote")) {
          if (!remoteUp) throw new HostUnavailableError("box", "connecting");
          return [];
        }
        return [scanned(1, "/local/app")];
      }),
      kill: vi.fn(),
    } as unknown as PortsBackend;
    const scanner = new PortScanner(hostsWith({ ports }));
    scanner.updateWorkspaces([ws("/local/app"), ws("/remote/app")]);
    const { window } = fakeWindow();
    const published: ActivePort[][] = [];
    const scannedHosts: string[] = [];
    scanner.onHostScanned((hostId) => {
      scannedHosts.push(hostId);
      // Listeners see the enriched scan already published.
      expect(published.length).toBeGreaterThan(0);
    });

    scanner.setEnricher((merged) => {
      published.push(merged);
      return merged;
    });
    scanner.start(window);
    await vi.advanceTimersByTimeAsync(3000);
    expect(scanner.hasScanned("local")).toBe(true);
    // An unavailable host has not been scanned…
    expect(scanner.hasScanned("box")).toBe(false);
    expect(scannedHosts).toEqual(["local"]);

    // …until a scan of it succeeds, even one with no ports.
    remoteUp = true;
    await vi.advanceTimersByTimeAsync(3000);
    expect(scanner.hasScanned("box")).toBe(true);
    expect(scannedHosts).toContain("box");
    scanner.stop();
  });

  it("keeps a remote host's last ports, without logging, while it is unavailable", async () => {
    vi.useFakeTimers();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let remoteUp = true;
    const ports = {
      scan: vi.fn(async (paths: string[]) => {
        if (paths[0].startsWith("/remote")) {
          if (!remoteUp) throw new HostUnavailableError("box", "connecting");
          return [scanned(9, "/remote/app")];
        }
        return [scanned(1, "/local/app")];
      }),
      kill: vi.fn(),
    } as unknown as PortsBackend;
    const scanner = new PortScanner(hostsWith({ ports }));
    scanner.updateWorkspaces([ws("/local/app"), ws("/remote/app")]);
    const { window, send } = fakeWindow();

    scanner.start(window);
    await vi.advanceTimersByTimeAsync(3000);
    const both = [port(1, "/local/app"), port(9, "/remote/app")];
    expect(send).toHaveBeenLastCalledWith("ports-changed", both);

    remoteUp = false;
    send.mockClear();
    await vi.advanceTimersByTimeAsync(6000);
    expect(send).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
    await expect(scanner.scanNow()).resolves.toEqual(both);
    expect(errors).not.toHaveBeenCalled();
    scanner.stop();
  });

  it("scanNow drops a failing remote host but keeps local ports", async () => {
    const ports = {
      scan: vi.fn(async (paths: string[]) => {
        if (paths[0].startsWith("/remote")) throw new Error("host unavailable");
        return [scanned(1, "/local/app")];
      }),
      kill: vi.fn(),
    } as unknown as PortsBackend;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const scanner = new PortScanner(hostsWith({ ports }));
    scanner.updateWorkspaces([ws("/local/app"), ws("/remote/app")]);
    await expect(scanner.scanNow()).resolves.toEqual([port(1, "/local/app")]);
  });

  describe("scanHost rate limit", () => {
    function deferredScanner() {
      const pending: Array<(ports: ScannedPort[]) => void> = [];
      const ports = {
        scan: vi.fn(
          (paths: string[]) =>
            new Promise<ScannedPort[]>((resolve) => {
              if (paths[0].startsWith("/remote")) pending.push(resolve);
              else resolve([]);
            }),
        ),
        kill: vi.fn(),
      } as unknown as PortsBackend;
      let now = 1_000;
      const scanner = new PortScanner(hostsWith({ ports }), () => now);
      scanner.updateWorkspaces([ws("/remote/app")]);
      const remoteScans = () =>
        vi.mocked(ports.scan).mock.calls.filter(([p]) => p[0] === "/remote/app").length;
      return { scanner, pending, remoteScans, advance: (ms: number) => (now += ms) };
    }

    it("shares one in-flight scan between concurrent callers", async () => {
      const { scanner, pending, remoteScans } = deferredScanner();
      const a = scanner.scanHost("box");
      const b = scanner.scanHost("box");
      const c = scanner.scanHost("box");
      expect(remoteScans()).toBe(1);
      pending[0]([scanned(9, "/remote/app")]);
      const results = await Promise.all([a, b, c]);
      for (const r of results) expect(r).toEqual([port(9, "/remote/app")]);
    });

    it("reuses a scan that finished within RESCAN_MIN_MS", async () => {
      const { scanner, pending, remoteScans, advance } = deferredScanner();
      const first = scanner.scanHost("box");
      pending[0]([scanned(9, "/remote/app")]);
      await first;
      advance(RESCAN_MIN_MS - 1);
      await expect(scanner.scanHost("box")).resolves.toEqual([port(9, "/remote/app")]);
      expect(remoteScans()).toBe(1);

      advance(1);
      const later = scanner.scanHost("box");
      expect(remoteScans()).toBe(2);
      pending[1]([scanned(10, "/remote/app")]);
      await expect(later).resolves.toEqual([port(10, "/remote/app")]);
    });

    it("the poller joins an on-demand scan instead of racing it", async () => {
      vi.useFakeTimers();
      const { scanner, pending, remoteScans } = deferredScanner();
      const { window, send } = fakeWindow();
      const onDemand = scanner.scanHost("box");
      scanner.start(window);
      await vi.advanceTimersByTimeAsync(3000);
      // The poller saw the on-demand scan in flight and did not start another.
      expect(remoteScans()).toBe(1);
      pending[0]([scanned(9, "/remote/app")]);
      await onDemand;
      await vi.advanceTimersByTimeAsync(3000);
      expect(remoteScans()).toBe(2);
      pending[1]([scanned(10, "/remote/app")]);
      await vi.advanceTimersByTimeAsync(0);
      expect(send).toHaveBeenLastCalledWith("ports-changed", [port(10, "/remote/app")]);
      // An on-demand call right after the poll reuses it rather than rescanning.
      await expect(scanner.scanHost("box")).resolves.toEqual([port(10, "/remote/app")]);
      expect(remoteScans()).toBe(2);
      scanner.stop();
    });
  });

  it("scans a host's workspaces in one call, and tags local ports too", async () => {
    const ports = {
      scan: vi.fn(async () => [scanned(1, "/a")]),
      kill: vi.fn(),
    } as unknown as PortsBackend;
    const scanner = new PortScanner(hostsWith({ ports }));
    scanner.updateWorkspaces([ws("/a"), ws("/b")]);
    await expect(scanner.scanNow()).resolves.toEqual([{ ...scanned(1, "/a"), hostId: "local" }]);
    expect(ports.scan).toHaveBeenCalledWith(["/a", "/b"]);
    expect(scanner.hostsListeningOn(1)).toEqual(["local"]);
  });

  it("scans this machine with no paths while no workspace is open", async () => {
    const ports = { scan: vi.fn(async () => []), kill: vi.fn() } as unknown as PortsBackend;
    const get = vi.fn(() => ({ ports }));
    const scanner = new PortScanner({ get } as unknown as HostBackends);
    await scanner.scanNow();
    expect(get).toHaveBeenCalledWith("local");
    expect(ports.scan).toHaveBeenCalledWith([]);
  });

  it("returns new objects from the enricher, leaving its own results alone", async () => {
    const ports = {
      scan: vi.fn(async () => [scanned(1, "/a")]),
      kill: vi.fn(),
    } as unknown as PortsBackend;
    const scanner = new PortScanner(hostsWith({ ports }));
    let suffix = "one";
    scanner.setEnricher((merged) => merged.map((p) => ({ ...p, hostname: suffix })));
    scanner.updateWorkspaces([ws("/a")]);
    expect((await scanner.scanNow())[0].hostname).toBe("one");
    suffix = "two";
    scanner.refresh();
    expect(scanner.latest()[0].hostname).toBe("two");
  });
});
