import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hostServerPaths } from "../../paths";
import { ensureServerRunning, probeSocket, restartServer, type LifecycleDeps } from "../lifecycle";
import type { SupervisedUnit, Supervisor } from "../supervisor";

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
  describe("under a supervisor (ADR-229 D4)", () => {
    /** A supervisor whose start and restart bring up a server of `version`, or throw. */
    function fakeSupervisor(opts: { version?: string; fail?: boolean; startsNothing?: boolean } = {}) {
      const calls: Array<[string, SupervisedUnit]> = [];
      const paths = hostServerPaths(dir);
      const bringUp = async (action: string, unit: SupervisedUnit) => {
        calls.push([action, unit]);
        if (opts.fail) throw new Error("Unit manor-host-server.service not found.");
        if (opts.startsNothing) return;
        await listen(paths.socket, opts.version ?? "2.0.0", process.pid);
      };
      const supervisor: Supervisor = {
        kind: "systemd",
        install: async () => {},
        uninstall: async () => {},
        status: async () => ({ kind: "systemd", running: { daemon: true, server: true } }),
        start: (unit) => bringUp("start", unit),
        restart: (unit) => bringUp("restart", unit),
        stop: async (unit) => {
          calls.push(["stop", unit]);
        },
      };
      return { supervisor, calls };
    }

    it("starts a server that is down through the supervisor, and spawns nothing", async () => {
      const { supervisor, calls } = fakeSupervisor();
      await ensureServerRunning(makeDeps({ supervisor: () => supervisor }));
      expect(calls).toEqual([["start", "server"]]);
      expect(spawned).toBe(0);
    });

    it("replaces a stale server with restart(\"server\"), never a detached spawn", async () => {
      const paths = hostServerPaths(dir);
      await listen(paths.socket, "1.0.0", process.pid);
      let dead = false;
      const { supervisor, calls } = fakeSupervisor();
      await ensureServerRunning(
        makeDeps({
          supervisor: () => supervisor,
          isAlive: (pid) => pid === process.pid && !dead,
          kill: (pid, sig) => {
            killed.push([pid, sig]);
            dead = true;
            servers.pop()?.close();
            fs.unlinkSync(paths.socket);
          },
        }),
      );
      expect(calls).toEqual([["restart", "server"]]);
      expect(spawned).toBe(0);
      expect(fs.readFileSync(paths.version, "utf-8").trim()).toBe("2.0.0");
    });

    it("falls back to the detached spawn, with a warning, when the supervisor is broken", async () => {
      const warnings: string[] = [];
      const { supervisor, calls } = fakeSupervisor({ fail: true });
      await ensureServerRunning(
        makeDeps({ supervisor: () => supervisor, warn: (m) => warnings.push(m) }),
      );
      expect(calls).toEqual([["start", "server"]]);
      expect(spawned).toBe(1);
      expect(warnings.join("\n")).toMatch(/could not start the server.*spawning it detached/);
    });

    it("falls back when the supervisor starts nothing that listens", async () => {
      const warnings: string[] = [];
      let clock = 0;
      const { supervisor } = fakeSupervisor({ startsNothing: true });
      await ensureServerRunning(
        makeDeps({
          supervisor: () => supervisor,
          warn: (m) => warnings.push(m),
          now: () => clock,
          // Time runs fast until the fallback has spawned, so its server can listen.
          sleep: async (ms) => {
            clock += spawned === 0 ? ms * 100 : 0;
            await new Promise((r) => setTimeout(r, Math.min(ms, 10)));
          },
        }),
      );
      expect(spawned).toBe(1);
      expect(warnings.join("\n")).toMatch(/started no server/);
    });
  });
  describe("restartServer (ADR-236 D4)", () => {
    /** A live 2.0.0 server whose kill (or supervised stop) takes it down. */
    async function liveServer() {
      const paths = hostServerPaths(dir);
      await listen(paths.socket, "2.0.0", process.pid);
      const state = { dead: false };
      const takeDown = () => {
        state.dead = true;
        servers.pop()?.close();
        fs.rmSync(paths.socket, { force: true });
      };
      const over: Partial<LifecycleDeps> = {
        isAlive: (pid) => pid === process.pid && !state.dead,
        kill: (pid, sig) => {
          killed.push([pid, sig]);
          takeDown();
        },
        spawnServer: () => {
          spawned++;
          state.dead = false;
          void listen(paths.socket, "2.0.0", process.pid);
        },
      };
      return { state, takeDown, over };
    }

    it("detached: SIGTERMs the live server, then starts a new one", async () => {
      const { over } = await liveServer();
      await restartServer(makeDeps(over));
      expect(killed).toEqual([[process.pid, "SIGTERM"]]);
      expect(spawned).toBe(1);
    });

    it("holds server.lock from the stop through the start, then releases it", async () => {
      const { over } = await liveServer();
      const lock = path.join(dir, "server.lock");
      const heldAt: boolean[] = [];
      await restartServer(
        makeDeps({
          ...over,
          kill: (pid, sig) => {
            heldAt.push(fs.existsSync(lock));
            over.kill?.(pid, sig);
          },
          spawnServer: (p) => {
            heldAt.push(fs.existsSync(lock));
            over.spawnServer?.(p);
          },
        }),
      );
      expect(heldAt).toEqual([true, true]);
      expect(fs.existsSync(lock)).toBe(false);
    });

    it("supervised: stops and starts through the supervisor, signalling nothing", async () => {
      const paths = hostServerPaths(dir);
      const { state, takeDown, over } = await liveServer();
      const calls: Array<[string, SupervisedUnit]> = [];
      const supervisor: Supervisor = {
        kind: "systemd",
        install: async () => {},
        uninstall: async () => {},
        status: async () => ({ kind: "systemd", running: { daemon: true, server: true } }),
        start: async (unit) => {
          calls.push(["start", unit]);
          state.dead = false;
          await listen(paths.socket, "2.0.0", process.pid);
        },
        restart: async (unit) => {
          calls.push(["restart", unit]);
        },
        stop: async (unit) => {
          calls.push(["stop", unit]);
          takeDown();
        },
      };
      await restartServer(makeDeps({ ...over, supervisor: () => supervisor }));
      expect(calls).toEqual([
        ["stop", "server"],
        ["start", "server"],
      ]);
      expect(killed).toEqual([]);
      expect(spawned).toBe(0);
    });

    it("supervised: signals the pid when the supervisor's stop leaves it alive", async () => {
      const { over } = await liveServer();
      let clock = 0;
      const supervisor: Supervisor = {
        kind: "systemd",
        install: async () => {},
        uninstall: async () => {},
        status: async () => ({ kind: "systemd", running: { daemon: true, server: true } }),
        start: async () => {
          throw new Error("no unit");
        },
        restart: async () => {},
        stop: async () => {},
      };
      await restartServer(
        makeDeps({
          ...over,
          supervisor: () => supervisor,
          warn: () => {},
          now: () => clock,
          sleep: async (ms) => {
            clock += ms * 100;
            await new Promise((r) => setTimeout(r, 1));
          },
        }),
      );
      expect(killed).toEqual([[process.pid, "SIGTERM"]]);
      expect(spawned).toBe(1);
    });

    it("SIGKILLs a server that ignores SIGTERM", async () => {
      const { takeDown, over } = await liveServer();
      let clock = 0;
      await restartServer(
        makeDeps({
          ...over,
          kill: (pid, sig) => {
            killed.push([pid, sig]);
            if (sig === "SIGKILL") takeDown();
          },
          now: () => clock,
          sleep: async (ms) => {
            clock += ms * 100;
            await new Promise((r) => setTimeout(r, 1));
          },
        }),
      );
      expect(killed.map((k) => k[1])).toEqual(["SIGTERM", "SIGKILL"]);
      expect(spawned).toBe(1);
    });

    it("with no server running, just starts one", async () => {
      await restartServer(makeDeps());
      expect(killed).toEqual([]);
      expect(spawned).toBe(1);
    });
  });
});
