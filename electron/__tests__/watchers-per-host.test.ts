/**
 * DiffWatcher and PortScanner poll each host on its own, so a remote host
 * that never answers cannot stall local polling (ADR-160 ticket 9).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import type { BrowserWindow } from "electron";
import { DiffWatcher } from "../diff-watcher";
import { PortScanner } from "../ports";
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
