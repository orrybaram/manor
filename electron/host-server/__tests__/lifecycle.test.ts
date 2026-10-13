import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hostServerPaths } from "../../paths";
import { ensureServerRunning, probeSocket, type LifecycleDeps } from "../lifecycle";

/**
 * The lifecycle against a temp data dir. "Spawning" `serve` starts a fake
 * server in this process: a unix socket plus the pid/version files, the way
 * `runServe` leaves them. The pid is this process's, so it reads as live.
 */
describe("ensureServerRunning", () => {
  let dir: string;
  let servers: net.Server[];
  let spawned: number;
  let killed: Array<[number, string]>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "manor-lifecycle-"));
    servers = [];
    spawned = 0;
    killed = [];
  });

  afterEach(async () => {
    await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function listen(socketPath: string, version: string, pid: number): Promise<void> {
    const paths = hostServerPaths(dir);
    try {
      fs.unlinkSync(socketPath);
    } catch {
      // none
    }
    return new Promise((resolve) => {
      const server = net.createServer((c) => c.destroy());
      servers.push(server);
      server.listen(socketPath, () => {
        fs.writeFileSync(paths.pid, `${pid}\n`);
        fs.writeFileSync(paths.version, `${version}\n`);
        resolve();
      });
    });
  }

  function makeDeps(over: Partial<LifecycleDeps> = {}, version = "2.0.0"): LifecycleDeps {
    const paths = hostServerPaths(dir);
    return {
      paths,
      version,
      spawnServer: () => {
        spawned++;
        void new Promise((r) => setTimeout(r, 30)).then(() =>
          listen(paths.socket, version, process.pid),
        );
      },
      isAlive: (pid) => pid === process.pid,
      kill: (pid, sig) => {
        killed.push([pid, sig]);
      },
      probeSocket,
      sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 10))),
      now: () => Date.now(),
      ...over,
    };
  }

  it("starts a server when none is running, and only once", async () => {
    await ensureServerRunning(makeDeps());
    expect(spawned).toBe(1);
    await ensureServerRunning(makeDeps());
    expect(spawned).toBe(1);
    expect(fs.existsSync(path.join(dir, "server.lock"))).toBe(false);
  });

  it("does nothing when a server of this version is healthy", async () => {
    await listen(hostServerPaths(dir).socket, "2.0.0", process.pid);
    await ensureServerRunning(makeDeps());
    expect(spawned).toBe(0);
    expect(killed).toEqual([]);
  });

  it("replaces a server of another version: SIGTERM, then start", async () => {
    const paths = hostServerPaths(dir);
    await listen(paths.socket, "1.0.0", process.pid);
    let dead = false;
    await ensureServerRunning(
      makeDeps({
        isAlive: (pid) => pid === process.pid && !dead,
        kill: (pid, sig) => {
          killed.push([pid, sig]);
          dead = true;
          servers.pop()?.close();
          fs.unlinkSync(paths.socket);
        },
        spawnServer: () => {
          spawned++;
          dead = false;
          void listen(paths.socket, "2.0.0", process.pid);
        },
      }),
    );
    expect(killed).toEqual([[process.pid, "SIGTERM"]]);
    expect(spawned).toBe(1);
    expect(fs.readFileSync(paths.version, "utf-8").trim()).toBe("2.0.0");
  });

  it("SIGKILLs a server that ignores SIGTERM", async () => {
    const paths = hostServerPaths(dir);
    await listen(paths.socket, "1.0.0", process.pid);
    let dead = false;
    let clock = 0;
    await ensureServerRunning(
      makeDeps({
        isAlive: (pid) => pid === process.pid && !dead,
        kill: (pid, sig) => {
          killed.push([pid, sig]);
          if (sig === "SIGKILL") {
            dead = true;
            servers.pop()?.close();
          }
        },
        spawnServer: () => {
          spawned++;
          dead = false;
          void listen(paths.socket, "2.0.0", process.pid);
        },
        now: () => clock,
        sleep: async (ms) => {
          clock += ms * 100;
        },
      }),
    );
    expect(killed.map((k) => k[1])).toEqual(["SIGTERM", "SIGKILL"]);
    expect(spawned).toBe(1);
  });

  it("never signals a live pid whose socket is dead", async () => {
    const paths = hostServerPaths(dir);
    fs.writeFileSync(paths.pid, `${process.pid}\n`);
    fs.writeFileSync(paths.version, "1.0.0\n");
    await ensureServerRunning(makeDeps());
    expect(killed).toEqual([]);
    expect(spawned).toBe(1);
  });

  it("two concurrent callers start one server", async () => {
    await Promise.all([
      ensureServerRunning(makeDeps()),
      ensureServerRunning(makeDeps()),
      ensureServerRunning(makeDeps()),
    ]);
    expect(spawned).toBe(1);
  });

  it("recovers a lock left by a dead process", async () => {
    fs.writeFileSync(path.join(dir, "server.lock"), "99999999\n");
    await ensureServerRunning(makeDeps({ isAlive: (pid) => pid === process.pid }));
    expect(spawned).toBe(1);
  });

  it("recovers an old lock even if its pid is alive", async () => {
    const lock = path.join(dir, "server.lock");
    fs.writeFileSync(lock, `${process.pid}\n`);
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(lock, old, old);
    await ensureServerRunning(makeDeps());
    expect(spawned).toBe(1);
  });

  it("rejects when the server never listens", async () => {
    let clock = 0;
    await expect(
      ensureServerRunning(
        makeDeps({
          spawnServer: () => {
            spawned++;
          },
          now: () => clock,
          sleep: async (ms) => {
            clock += ms * 100;
          },
        }),
      ),
    ).rejects.toThrow(/did not start/);
    expect(fs.existsSync(path.join(dir, "server.lock"))).toBe(false);
  });
});
