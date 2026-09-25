/**
 * DiffWatcher and PortScanner poll each host on its own, so a remote host
 * that never answers cannot stall local polling (ADR-160 ticket 9).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import type { BrowserWindow } from "electron";
import { DiffWatcher } from "../diff-watcher";
import { PortScanner, RESCAN_MIN_MS } from "../ports";
import type { ActivePort, GitBackend, PortsBackend } from "../backend/types";
import { HostUnavailableError } from "../backend/registry";

const hostForPath = (p: string) => (p.startsWith("/remote") ? "box" : "local");

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
    const watcher = new DiffWatcher(git, hostForPath);
    const { window, send } = fakeWindow();

    watcher.start(window, { "/local/app": "main", "/remote/app": "main" });
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
    const watcher = new DiffWatcher(git, hostForPath);
    const { window, send } = fakeWindow();
    const both = {
      "/local/app": { added: 4, removed: 0 },
      "/remote/app": { added: 4, removed: 0 },
    };

    watcher.start(window, { "/local/app": "main", "/remote/app": "main" });
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

  it("without a host resolver, scans every workspace as one local group", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const git = {
      exec: vi.fn(async (_cwd: string, args: string[]) =>
        args[0] === "merge-base" ? "abc" : " 1 file changed, 3 deletions(-)",
      ),
    } as unknown as GitBackend;
    const watcher = new DiffWatcher(git);
    const { window, send } = fakeWindow();
    watcher.start(window, { "/a": "main", "/remote/b": "main" });
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith("diffs-changed", {
        "/a": { added: 0, removed: 3 },
        "/remote/b": { added: 0, removed: 3 },
      }),
    );
    watcher.stop();
  });
});

describe("PortScanner per host", () => {
  const port = (pid: number, workspacePath: string): ActivePort => ({
    port: 3000 + pid,
    processName: "node",
    pid,
    workspacePath,
    hostname: null,
  });

  it("publishes local ports while a remote scan hangs", async () => {
    vi.useFakeTimers();
    let pid = 1;
    const ports = {
      scan: vi.fn(async (paths: string[]) => {
        if (paths.some((p) => p.startsWith("/remote"))) return never();
        return [port(pid, "/local/app")];
      }),
      kill: vi.fn(),
    } as unknown as PortsBackend;
    const scanner = new PortScanner(ports, hostForPath);
    scanner.updateWorkspacePaths(["/local/app", "/remote/app"]);
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
        return [port(1, "/local/app")];
      }),
      kill: vi.fn(),
    } as unknown as PortsBackend;
    const scanner = new PortScanner(ports, hostForPath);
    scanner.updateWorkspacePaths(["/local/app", "/remote/app"]);
    const { window } = fakeWindow();
    const published: ActivePort[][] = [];
    const scanned: string[] = [];
    scanner.onHostScanned((hostId) => {
      scanned.push(hostId);
      // Listeners see the enriched scan already published.
      expect(published.length).toBeGreaterThan(0);
    });

    scanner.start(window, (merged) => {
      published.push(merged);
      return merged;
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(scanner.hasScanned("local")).toBe(true);
    // An unavailable host has not been scanned…
    expect(scanner.hasScanned("box")).toBe(false);
    expect(scanned).toEqual(["local"]);

    // …until a scan of it succeeds, even one with no ports.
    remoteUp = true;
    await vi.advanceTimersByTimeAsync(3000);
    expect(scanner.hasScanned("box")).toBe(true);
    expect(scanned).toContain("box");
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
          return [port(9, "/remote/app")];
        }
        return [port(1, "/local/app")];
      }),
      kill: vi.fn(),
    } as unknown as PortsBackend;
    const scanner = new PortScanner(ports, hostForPath);
    scanner.updateWorkspacePaths(["/local/app", "/remote/app"]);
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
        return [port(1, "/local/app")];
      }),
      kill: vi.fn(),
    } as unknown as PortsBackend;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const scanner = new PortScanner(ports, hostForPath);
    scanner.updateWorkspacePaths(["/local/app", "/remote/app"]);
    await expect(scanner.scanNow()).resolves.toEqual([port(1, "/local/app")]);
  });

  describe("scanHost rate limit", () => {
    function deferredScanner() {
      const pending: Array<(ports: ActivePort[]) => void> = [];
      const ports = {
        scan: vi.fn(
          (paths: string[]) =>
            new Promise<ActivePort[]>((resolve) => {
              if (paths[0].startsWith("/remote")) pending.push(resolve);
              else resolve([]);
            }),
        ),
        kill: vi.fn(),
      } as unknown as PortsBackend;
      let now = 1_000;
      const scanner = new PortScanner(ports, hostForPath, () => now);
      scanner.updateWorkspacePaths(["/remote/app"]);
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
      pending[0]([port(9, "/remote/app")]);
      const results = await Promise.all([a, b, c]);
      for (const r of results) expect(r).toEqual([port(9, "/remote/app")]);
    });

    it("reuses a scan that finished within RESCAN_MIN_MS", async () => {
      const { scanner, pending, remoteScans, advance } = deferredScanner();
      const first = scanner.scanHost("box");
      pending[0]([port(9, "/remote/app")]);
      await first;
      advance(RESCAN_MIN_MS - 1);
      await expect(scanner.scanHost("box")).resolves.toEqual([port(9, "/remote/app")]);
      expect(remoteScans()).toBe(1);

      advance(1);
      const later = scanner.scanHost("box");
      expect(remoteScans()).toBe(2);
      pending[1]([port(10, "/remote/app")]);
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
      pending[0]([port(9, "/remote/app")]);
      await onDemand;
      await vi.advanceTimersByTimeAsync(3000);
      expect(remoteScans()).toBe(2);
      pending[1]([port(10, "/remote/app")]);
      await vi.advanceTimersByTimeAsync(0);
      expect(send).toHaveBeenLastCalledWith("ports-changed", [port(10, "/remote/app")]);
      // An on-demand call right after the poll reuses it rather than rescanning.
      await expect(scanner.scanHost("box")).resolves.toEqual([port(10, "/remote/app")]);
      expect(remoteScans()).toBe(2);
      scanner.stop();
    });
  });

  it("with no resolver scans all paths in one call", async () => {
    const ports = {
      scan: vi.fn(async () => []),
      kill: vi.fn(),
    } as unknown as PortsBackend;
    const scanner = new PortScanner(ports);
    scanner.updateWorkspacePaths(["/a", "/b"]);
    await scanner.scanNow();
    expect(ports.scan).toHaveBeenCalledWith(["/a", "/b"]);
  });
});
