/**
 * `processes.killSession`, `processes.killAll`, `processes.killDaemon`.
 *
 * No `ipcMain` here any more: `processes` crossed to the handler table in
 * ADR-180 ticket 8, so these are plain functions over `HostDeps` — the same
 * functions the table calls, and a paired `full` device now reaches them the
 * same way the desktop does.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { daemonPidFile, daemonSocketFile } from "../paths";
import {
  processesKillSession,
  processesKillAll,
  processesKillDaemon,
} from "../bridge/handlers/processes";
import { localCtx } from "../bridge/method";

// ── Mock ipc-validate ────────────────────────────────────────────────────────
vi.mock("../ipc-validate", () => ({
  assertString: vi.fn(),
}));

// ── Mock portless (imported for its side effect / proxy port) ───────────────
vi.mock("../portless", () => ({
  portlessManager: { proxyPort: null, restart: vi.fn() },
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    backend: {
      pty: {
        listSessions: vi.fn().mockResolvedValue([]),
        kill: vi.fn().mockResolvedValue(undefined),
      },
      ports: {
        kill: vi.fn().mockResolvedValue(undefined),
      },
    },
    portScanner: {
      scanNow: vi.fn().mockResolvedValue([]),
    },
    agentHookServer: { hookPort: null },
    webviewServer: { serverPort: null },
    agentManager: {
      getAgentByPaneId: vi.fn().mockReturnValue(null),
    },
    statsStore: {
      record: vi.fn(),
    },
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("processes.killSession / processes.killAll stats", () => {
  let deps: ReturnType<typeof makeDeps>;
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    deps = makeDeps();
    // These handlers signal whatever pid is in ~/.manor/daemon/terminal-host.pid.
    // $HOME is a temp dir under vitest (ADR-169), but never let a real signal
    // out of this file regardless.
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
  });

  afterEach(() => {
    killSpy.mockRestore();
    fs.rmSync(daemonPidFile(), { force: true });
  });

  describe("daemon pid handling (ADR-169)", () => {
    it("killAll signals nothing when there is no daemon pid file", async () => {
      expect(fs.existsSync(daemonPidFile())).toBe(false);

      await processesKillAll(localCtx(deps as never));

      expect(killSpy).not.toHaveBeenCalled();
    });

    it("killDaemon SIGTERMs the pid from the pid file and removes the files", async () => {
      fs.mkdirSync(path.dirname(daemonPidFile()), { recursive: true });
      fs.writeFileSync(daemonPidFile(), "424242");
      fs.writeFileSync(daemonSocketFile(), "");

      await processesKillDaemon();

      expect(killSpy).toHaveBeenCalledWith(424242, "SIGTERM");
      expect(fs.existsSync(daemonPidFile())).toBe(false);
      expect(fs.existsSync(daemonSocketFile())).toBe(false);
    });
  });

  describe("processes.killSession", () => {
    it("records a kill for an active agent last seen thinking/working/requires_input", async () => {
      deps.agentManager.getAgentByPaneId.mockReturnValue({
        id: "t1",
        status: "active",
        lastAgentStatus: "thinking",
      });

      await processesKillSession(localCtx(deps as never), "session-1");

      expect(deps.statsStore.record).toHaveBeenCalledTimes(2);
      expect(deps.statsStore.record).toHaveBeenCalledWith("agentsKilled");
      expect(deps.statsStore.record).toHaveBeenCalledWith("agentsKilledMidThought");
      expect(deps.backend.pty.kill).toHaveBeenCalledWith("session-1");
    });

    it("does not record a kill when no agent is found for the pane", async () => {
      deps.agentManager.getAgentByPaneId.mockReturnValue(null);

      await processesKillSession(localCtx(deps as never), "session-1");

      expect(deps.statsStore.record).not.toHaveBeenCalled();
    });

    it("records a kill for an agent that already responded", async () => {
      deps.agentManager.getAgentByPaneId.mockReturnValue({
        id: "t1",
        status: "active",
        lastAgentStatus: "responded",
      });

      await processesKillSession(localCtx(deps as never), "session-1");

      expect(deps.statsStore.record).toHaveBeenCalledTimes(1);
      expect(deps.statsStore.record).toHaveBeenCalledWith("agentsKilled");
    });
  });

  describe("processes.killAll", () => {
    it("records once per active session being killed", async () => {
      deps.backend.pty.listSessions.mockResolvedValue([
        { sessionId: "s1" },
        { sessionId: "s2" },
        { sessionId: "s3" },
      ]);
      deps.agentManager.getAgentByPaneId.mockImplementation((paneId: string) => {
        if (paneId === "s1") return { id: "a1", status: "active", lastAgentStatus: "working" };
        if (paneId === "s2") return { id: "a2", status: "active", lastAgentStatus: "responded" };
        if (paneId === "s3") return { id: "a3", status: "active", lastAgentStatus: null };
        return null;
      });

      await processesKillAll(localCtx(deps as never));

      expect(deps.statsStore.record).toHaveBeenCalledTimes(3);
      expect(deps.statsStore.record).toHaveBeenCalledWith("agentsKilled");
      expect(deps.statsStore.record).toHaveBeenCalledWith("agentsKilledMidThought");
      expect(deps.backend.pty.kill).toHaveBeenCalledTimes(3);
    });
  });
});
