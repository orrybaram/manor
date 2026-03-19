import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PassThrough } from "node:stream";
import { MSG, encodeFrame } from "./pty-subprocess-ipc";

import "./xterm-env-polyfill";

vi.mock("node:child_process", () => ({
  fork: vi.fn(() => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    return { stdin, stdout, on: vi.fn(), kill: vi.fn(), pid: 99999 };
  }),
}));

vi.mock("../shell", () => ({
  ShellManager: {
    zdotdirPath: () => "/tmp/manor-test-zdotdir",
    historyFileFor: (id: string) => `/tmp/manor-test-sessions/${id}.history`,
    setupZdotdir: () => "/tmp/manor-test-zdotdir",
  },
}));

import { TerminalHost } from "./terminal-host";

function mockSocket(): any {
  return { write: vi.fn(), on: vi.fn(), destroy: vi.fn() };
}

function feedSessionData(host: TerminalHost, sessionId: string, data: string): void {
  const session = (host as any).sessions.get(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);
  const frame = encodeFrame(MSG.DATA, data);
  (session as any).decoder.push(frame);
}

describe("TerminalHost", () => {
  let host: TerminalHost;

  beforeEach(() => { host = new TerminalHost(); });
  afterEach(() => { host.disposeAll(); });

  describe("create", () => {
    it("creates a new session", () => {
      const info = host.create("s1", "/tmp", 80, 24);
      expect(info.sessionId).toBe("s1");
      expect(info.cwd).toBe("/tmp");
      expect(info.cols).toBe(80);
      expect(info.rows).toBe(24);
      expect(info.alive).toBe(true);
    });

    it("returns existing session for duplicate ID", () => {
      host.create("s1", "/tmp", 80, 24);
      const info = host.create("s1", "/other", 120, 40);
      expect(info.sessionId).toBe("s1");
      expect(info.cwd).toBe("/tmp");
    });

    it("creates multiple sessions", () => {
      host.create("s1", "/tmp", 80, 24);
      host.create("s2", "/home", 120, 40);
      expect(host.listSessions()).toHaveLength(2);
    });
  });

  describe("listSessions", () => {
    it("returns empty list initially", () => {
      expect(host.listSessions()).toEqual([]);
    });

    it("returns all created sessions", () => {
      host.create("s1", "/tmp", 80, 24);
      host.create("s2", "/home", 120, 40);
      host.create("s3", "/", 80, 24);
      const sessions = host.listSessions();
      expect(sessions).toHaveLength(3);
      expect(sessions.map((s) => s.sessionId).sort()).toEqual(["s1", "s2", "s3"]);
    });
  });

  describe("attach / detach", () => {
    it("attach returns snapshot", async () => {
      host.create("s1", "/tmp", 80, 24);
      const socket = mockSocket();
      const snapshot = await host.attach("s1", socket);
      expect(snapshot).not.toBeNull();
      expect(snapshot!.cols).toBe(80);
      expect(snapshot!.rows).toBe(24);
    });

    it("attach to nonexistent session returns null", async () => {
      const socket = mockSocket();
      const snapshot = await host.attach("nonexistent", socket);
      expect(snapshot).toBeNull();
    });

    it("attached client receives data events", async () => {
      host.create("s1", "/tmp", 80, 24);
      const socket = mockSocket();
      await host.attach("s1", socket);
      feedSessionData(host, "s1", "hello from pty");

      expect(socket.write).toHaveBeenCalled();
      const writtenLine = socket.write.mock.calls[0][0];
      const event = JSON.parse(writtenLine.trim());
      expect(event.type).toBe("data");
      expect(event.data).toBe("hello from pty");
    });

    it("detached client stops receiving events", async () => {
      host.create("s1", "/tmp", 80, 24);
      const socket = mockSocket();
      await host.attach("s1", socket);
      host.detach("s1", socket);
      feedSessionData(host, "s1", "after detach");

      const dataWrites = socket.write.mock.calls.filter((call: any[]) => {
        try {
          const e = JSON.parse(call[0].trim());
          return e.type === "data" && e.data === "after detach";
        } catch { return false; }
      });
      expect(dataWrites).toHaveLength(0);
    });

    it("multiple clients can subscribe to same session", async () => {
      host.create("s1", "/tmp", 80, 24);
      const socket1 = mockSocket();
      const socket2 = mockSocket();
      await host.attach("s1", socket1);
      await host.attach("s1", socket2);
      feedSessionData(host, "s1", "broadcast");

      expect(socket1.write).toHaveBeenCalled();
      expect(socket2.write).toHaveBeenCalled();
    });
  });

  describe("snapshot with content", () => {
    it("snapshot contains data written to session", async () => {
      host.create("s1", "/tmp", 80, 24);
      feedSessionData(host, "s1", "important output");
      const snapshot = await host.getSnapshot("s1");
      expect(snapshot).not.toBeNull();
      expect(snapshot!.screenAnsi).toContain("important output");
    });

    it("snapshot for nonexistent session returns null", async () => {
      expect(await host.getSnapshot("nonexistent")).toBeNull();
    });

    it("snapshot preserves CWD from OSC 7", async () => {
      host.create("s1", "/tmp", 80, 24);
      feedSessionData(host, "s1", "\x1b]7;file://localhost/Users/test\x07");
      const snapshot = await host.getSnapshot("s1");
      expect(snapshot!.cwd).toBe("/Users/test");
    });

    it("snapshot preserves modes", async () => {
      host.create("s1", "/tmp", 80, 24);
      feedSessionData(host, "s1", "\x1b[?2004h\x1b[?1049h");
      const snapshot = await host.getSnapshot("s1");
      expect(snapshot!.modes.bracketedPaste).toBe(true);
      expect(snapshot!.modes.altScreen).toBe(true);
    });
  });

  describe("warm restore: disconnect and reconnect", () => {
    it("session survives client detach", async () => {
      host.create("s1", "/tmp", 80, 24);
      feedSessionData(host, "s1", "preserved content");

      const socket = mockSocket();
      await host.attach("s1", socket);
      host.detach("s1", socket);

      expect(host.listSessions()).toHaveLength(1);
      expect(host.listSessions()[0].alive).toBe(true);

      const snapshot = await host.getSnapshot("s1");
      expect(snapshot!.screenAnsi).toContain("preserved content");
    });

    it("new client can attach after previous client detached", async () => {
      host.create("s1", "/tmp", 80, 24);
      feedSessionData(host, "s1", "old content");

      const socket1 = mockSocket();
      await host.attach("s1", socket1);
      host.detach("s1", socket1);

      const socket2 = mockSocket();
      const snapshot = await host.attach("s1", socket2);
      expect(snapshot!.screenAnsi).toContain("old content");
    });

    it("detachAllFromSocket removes socket from all sessions", async () => {
      host.create("s1", "/tmp", 80, 24);
      host.create("s2", "/tmp", 80, 24);

      const socket = mockSocket();
      await host.attach("s1", socket);
      await host.attach("s2", socket);
      host.detachAllFromSocket(socket);

      feedSessionData(host, "s1", "test");
      feedSessionData(host, "s2", "test");

      const dataWritesAfterDetach = socket.write.mock.calls.filter((call: any[]) => {
        try {
          const e = JSON.parse(call[0].trim());
          return e.type === "data" && e.data === "test";
        } catch { return false; }
      });
      expect(dataWritesAfterDetach).toHaveLength(0);
    });
  });

  describe("resize", () => {
    it("resize updates session dimensions", async () => {
      host.create("s1", "/tmp", 80, 24);
      host.resize("s1", 120, 40);
      const snapshot = await host.getSnapshot("s1");
      expect(snapshot!.cols).toBe(120);
      expect(snapshot!.rows).toBe(40);
    });

    it("resize nonexistent session is a no-op", () => {
      host.resize("nonexistent", 120, 40);
    });
  });

  describe("kill", () => {
    it("kill sends kill to session", () => {
      host.create("s1", "/tmp", 80, 24);
      host.kill("s1");
      expect(host.listSessions()).toHaveLength(1);
    });

    it("kill nonexistent session is a no-op", () => {
      host.kill("nonexistent");
    });
  });

  describe("dispose", () => {
    it("disposeSession removes session", () => {
      host.create("s1", "/tmp", 80, 24);
      host.disposeSession("s1");
      expect(host.listSessions()).toHaveLength(0);
    });

    it("disposeAll removes all sessions", () => {
      host.create("s1", "/tmp", 80, 24);
      host.create("s2", "/tmp", 80, 24);
      host.disposeAll();
      expect(host.listSessions()).toHaveLength(0);
    });
  });
});
