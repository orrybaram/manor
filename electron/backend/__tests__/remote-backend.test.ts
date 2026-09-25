/**
 * RemoteBackend wiring, end to end through a real `TerminalHostClient` over
 * an in-memory transport — no sshd, no daemon process. The fake daemon
 * speaks just enough of the NDJSON protocol to answer the client and
 * records every request, so the tests can assert on what hits the wire.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { Duplex } from "node:stream";
import type { HostTransport } from "../../terminal-host/transport";
import {
  TERMINAL_HOST_PROTOCOL,
  type ControlResponse,
  type StreamEvent,
} from "../../terminal-host/types";
import { RemoteBackend, remoteReconnectDelayMs } from "../remote-backend";
import type { HostConnectionEvent } from "../types";
import { SshAuthError } from "../../terminal-host/ssh-config";
import { RemoteBootstrapError } from "../remote-bootstrap";

type Json = Record<string, unknown> & { type: string };

/** One end of an in-memory connection; what one end writes, the other reads. */
class MemoryEnd extends Duplex {
  peer: MemoryEnd | null = null;
  _read(): void {}
  _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.peer?.push(chunk);
    cb();
  }
}

/** A client/server pair of connected in-memory streams. */
function duplexPair(): { client: Duplex; server: Duplex } {
  const client = new MemoryEnd();
  const server = new MemoryEnd();
  client.peer = server;
  server.peer = client;
  return { client, server };
}

function onLines(stream: Duplex, handle: (msg: Json) => void): void {
  let buffer = "";
  stream.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf-8");
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    for (const line of lines) if (line.trim()) handle(JSON.parse(line) as Json);
  });
}

class FakeDaemon {
  /** Every control request, minus the connect chatter. */
  readonly control: Json[] = [];
  /** Every stream command after the stream preamble. */
  readonly stream: Json[] = [];
  /** The `env` of every `updateEnv`, including the one each connect sends. */
  readonly envUpdates: Record<string, string>[] = [];
  /** Sessions `listSessions` reports as alive. */
  readonly sessions = new Set<string>();
  /** Answer for `exec` requests. */
  execReply: (req: Json) => ControlResponse = () => ({
    type: "execResult",
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  bootstrapReply: ControlResponse = { type: "bootstrapped", agents: [] };
  /** Drop every connection instead of answering the next N `listSessions`. */
  dropOnListSessions = 0;
  private streamSocket: Duplex | null = null;
  /** Client ends of every open connection, so a test can "kill ssh". */
  readonly clientEnds: Duplex[] = [];

  accept(control: boolean): Duplex {
    const { client, server } = duplexPair();
    this.clientEnds.push(client);
    if (control) {
      onLines(server, (msg) => this.onControl(server, msg));
    } else {
      let initialized = false;
      onLines(server, (msg) => {
        if (!initialized) {
          initialized = true;
          this.streamSocket = server;
          return;
        }
        this.stream.push(msg);
        if (msg.type === "execCancel") {
          this.emit({ type: "execExit", execId: msg.execId as string, exitCode: null });
        }
      });
    }
    return client;
  }

  /** Push a stream event to the connected client. */
  emit(event: StreamEvent): void {
    this.streamSocket?.write(JSON.stringify(event) + "\n");
  }

  /** The ssh child exited: every connection closes under the client. */
  dropConnections(): void {
    for (const end of this.clientEnds.splice(0)) end.destroy();
    this.streamSocket = null;
  }

  private onControl(socket: Duplex, msg: Json): void {
    const reply = (resp: ControlResponse): void => {
      socket.write(JSON.stringify({ ...resp, requestId: msg.requestId }) + "\n");
    };
    switch (msg.type) {
      case "auth":
        return reply({ type: "authOk" });
      case "handshake":
        return reply({
          type: "handshake",
          daemonVersion: msg.clientVersion as string,
          protocol: TERMINAL_HOST_PROTOCOL,
        });
      case "updateEnv":
        this.envUpdates.push(msg.env as Record<string, string>);
        return reply({ type: "envUpdated" });
    }
    this.control.push(msg);
    switch (msg.type) {
      case "exec":
        return reply(this.execReply(msg));
      case "readFile":
        return reply({ type: "fileContents", contents: `contents of ${String(msg.path)}` });
      case "bootstrap":
        return reply(this.bootstrapReply);
      case "listSessions":
        if (this.dropOnListSessions > 0) {
          this.dropOnListSessions--;
          return this.dropConnections();
        }
        return reply({
          type: "sessions",
          sessions: [...this.sessions].map((sessionId) => ({
            sessionId,
            cwd: "/",
            cols: 80,
            rows: 24,
            alive: true,
          })),
        });
      case "resize":
        return reply({ type: "resized" });
      case "getSnapshot":
        return reply({ type: "notFound", sessionId: msg.sessionId as string });
      case "create":
        this.sessions.add(msg.sessionId as string);
        return reply({
          type: "created",
          session: {
            sessionId: msg.sessionId as string,
            cwd: msg.cwd as string,
            cols: 80,
            rows: 24,
            alive: true,
          },
        });
      default:
        return reply({ type: "error", message: `unknown request type: ${msg.type}` });
    }
  }
}

class FakeTransport implements HostTransport {
  readonly handshakeTimeoutMs = 60_000;
  ensureRunning = vi.fn(async (_version?: string) => {});
  restart = vi.fn(async () => {});
  dispose = vi.fn(async () => {});
  reset = vi.fn(() => {});
  /** When set, `connectStream` waits for it before answering. */
  streamGate: Promise<void> | null = null;
  /** Makes `connectControl` refuse, as a dead host would. */
  unreachable = false;
  controlConnects = 0;
  constructor(readonly daemon: FakeDaemon) {}
  async connectControl(): Promise<Duplex> {
    this.controlConnects++;
    if (this.unreachable) throw new Error("ssh: connect to host box: Connection refused");
    return this.daemon.accept(true);
  }
  async connectStream(): Promise<Duplex> {
    await this.streamGate;
    return this.daemon.accept(false);
  }
  async authToken(): Promise<string> {
    return "token";
  }
}

function setup(opts: { reconnectDelayMs?: (attempt: number) => number | null } = {}) {
  const daemon = new FakeDaemon();
  const transport = new FakeTransport(daemon);
  const backend = new RemoteBackend({
    target: "user@box",
    version: "1.2.3",
    transport,
    ...opts,
  });
  const hostEvents: HostConnectionEvent[] = [];
  backend.onHostEvent((e) => hostEvents.push(e));
  return { daemon, transport, backend, hostEvents };
}

async function waitFor(pred: () => boolean, label: string, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

let current: RemoteBackend | null = null;
afterEach(async () => {
  vi.useRealTimers();
  await current?.disconnect();
  current = null;
});

describe("RemoteBackend", () => {
  describe("connect / disconnect", () => {
    it("ensures the host, connects, then bootstraps", async () => {
      const { backend, transport, daemon } = setup();
      current = backend;
      daemon.bootstrapReply = { type: "bootstrapped", agents: ["claude", "codex"] };
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await backend.connect();

      expect(transport.ensureRunning).toHaveBeenCalledWith("1.2.3");
      expect(daemon.control.map((r) => r.type)).toEqual(["bootstrap"]);
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it("tolerates a daemon that predates bootstrap, with a warning", async () => {
      const { backend, daemon } = setup();
      current = backend;
      daemon.bootstrapReply = { type: "error", message: "unknown request type: bootstrap" };
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await expect(backend.connect()).resolves.toBeUndefined();
      expect(daemon.control.map((r) => r.type)).toEqual(["bootstrap"]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("does not support bootstrap"),
      );
      warn.mockRestore();
    });

    it("does not fail connect when bootstrap errors", async () => {
      const { backend, daemon } = setup();
      current = backend;
      daemon.bootstrapReply = { type: "error", message: "EACCES writing hook script" };
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await expect(backend.connect()).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("EACCES"));
      warn.mockRestore();
    });

    it("disconnect disposes the transport", async () => {
      const { backend, transport } = setup();
      await backend.connect();
      await backend.disconnect();
      expect(transport.dispose).toHaveBeenCalledOnce();
    });

    it("a disconnect during ensureRunning stops the connect before it opens anything", async () => {
      const { backend, transport } = setup();
      let release!: () => void;
      transport.ensureRunning.mockImplementationOnce(
        () => new Promise<void>((r) => (release = r)),
      );
      const connecting = backend.connect();
      await waitFor(() => transport.ensureRunning.mock.calls.length > 0, "ensureRunning");
      await backend.disconnect();
      release();
      await expect(connecting).rejects.toThrow("Disconnected while connecting");
      expect(transport.controlConnects).toBe(0);
    });

    it("a disconnect while the stream socket opens closes both sockets", async () => {
      const { backend, transport, daemon } = setup();
      let release!: () => void;
      transport.streamGate = new Promise<void>((r) => (release = r));
      const connecting = backend.connect();
      await waitFor(() => transport.controlConnects > 0, "control socket");
      await backend.disconnect();
      release();
      await expect(connecting).rejects.toThrow("Disconnected while connecting");
      expect(daemon.clientEnds).toHaveLength(2);
      expect(daemon.clientEnds.every((end) => end.destroyed)).toBe(true);
      // Nothing talks to the daemon behind the caller's back.
      expect(daemon.control).toEqual([]);
    });

    it("connect after disconnect resets the transport and connects again", async () => {
      const { backend, transport, daemon } = setup();
      current = backend;
      await backend.connect();
      await backend.disconnect();
      expect(transport.reset).toHaveBeenCalledTimes(1);
      await backend.connect();
      expect(transport.reset).toHaveBeenCalledTimes(2);
      expect(daemon.control.map((r) => r.type)).toEqual(["bootstrap", "bootstrap"]);
    });
  });

  describe("updateEnv", () => {
    it("sends the env to the daemon, and again on every reconnect", async () => {
      const { backend, daemon } = setup({ reconnectDelayMs: () => 0 });
      current = backend;
      await backend.connect();

      await backend.pty.updateEnv({ MANOR_TEST_VAR: "one" });
      expect(daemon.envUpdates[daemon.envUpdates.length - 1]).toEqual({ MANOR_TEST_VAR: "one" });

      // A reconnect (possibly to a respawned daemon) carries it along.
      const before = daemon.envUpdates.length;
      daemon.dropConnections();
      await waitFor(() => daemon.envUpdates.length > before, "reconnect env push");
      expect(daemon.envUpdates[daemon.envUpdates.length - 1]).toMatchObject({ MANOR_TEST_VAR: "one" });
    });
  });

  describe("git over the wire", () => {
    it("sends git commands to the daemon unchanged", async () => {
      const { backend, daemon } = setup();
      current = backend;
      await backend.connect();

      await backend.git.stage("/srv/repo", ["a b.txt", "--weird"]);
      await backend.git.worktreeAdd("/srv/repo", "/srv/wt/x", "feat", {
        createBranch: true,
        startPoint: "origin/main",
      });

      const execs = daemon.control.filter((r) => r.type === "exec");
      expect(execs.map(({ requestId: _, ...rest }) => rest)).toEqual([
        {
          type: "exec",
          cmd: "git",
          args: ["add", "--", "a b.txt", "--weird"],
          cwd: "/srv/repo",
          timeout: 10000,
        },
        {
          type: "exec",
          cmd: "git",
          args: ["worktree", "add", "/srv/wt/x", "-b", "feat", "origin/main"],
          cwd: "/srv/repo",
          timeout: 15000,
        },
      ]);
    });

    it("turns a failed commit into the parsed commit error", async () => {
      const { backend, daemon } = setup();
      current = backend;
      daemon.execReply = () => ({
        type: "execResult",
        stdout: "",
        stderr: "error: pathspec did not match",
        exitCode: 1,
      });
      await backend.connect();
      await expect(backend.git.commit("/srv/repo", "msg", [])).rejects.toThrow(
        "error: pathspec did not match",
      );
    });

    it("reads untracked files through the daemon", async () => {
      const { backend, daemon } = setup();
      current = backend;
      daemon.execReply = (req) => {
        const args = req.args as string[];
        if (args[0] === "diff") return { type: "execResult", stdout: "", stderr: "", exitCode: 0 };
        return { type: "execResult", stdout: "new.txt\n", stderr: "", exitCode: 0 };
      };
      await backend.connect();
      const diff = await backend.git.getLocalDiff("/srv/repo");
      expect(daemon.control).toContainEqual(
        expect.objectContaining({ type: "readFile", path: "/srv/repo/new.txt" }),
      );
      expect(diff).toContain("+contents of /srv/repo/new.txt");
    });

    it("pushes over execStream: branch resolved remotely, env overrides passed, chunks relayed", async () => {
      const { backend, daemon } = setup();
      current = backend;
      daemon.execReply = () => ({
        type: "execResult",
        stdout: "feature\n",
        stderr: "",
        exitCode: 0,
      });
      await backend.connect();
      const lines: string[] = [];
      const onDone = vi.fn();
      backend.git.pushStream(
        "/srv/repo",
        { setUpstream: true },
        { onLine: (l) => lines.push(l), onDone },
      );

      await waitFor(() => daemon.stream.some((c) => c.type === "execStream"), "execStream");
      expect(daemon.control).toContainEqual(
        expect.objectContaining({ type: "exec", args: ["rev-parse", "--abbrev-ref", "HEAD"] }),
      );
      const cmd = daemon.stream.find((c) => c.type === "execStream")!;
      expect(cmd).toMatchObject({
        cmd: "git",
        args: ["push", "--set-upstream", "origin", "feature"],
        cwd: "/srv/repo",
        env: { GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/bin/true" },
      });

      const execId = cmd.execId as string;
      daemon.emit({ type: "execStderr", execId, data: "Enumerating\nWriting" });
      daemon.emit({ type: "execExit", execId, exitCode: 0 });
      await waitFor(() => onDone.mock.calls.length > 0, "push done");
      expect(lines).toEqual(["Enumerating", "Writing"]);
      expect(onDone).toHaveBeenCalledWith({ exitCode: 0, stderr: "Enumerating\nWriting" });
    });
  });

  describe("ports over the wire", () => {
    it("kills a remote pid on the remote, and scans as the remote uid", async () => {
      const killSpy = vi.spyOn(process, "kill");
      const { backend, daemon } = setup();
      current = backend;
      daemon.execReply = (req) => ({
        type: "execResult",
        stdout: req.cmd === "id" ? "1001\n" : "",
        stderr: "",
        exitCode: 0,
      });
      await backend.connect();

      await backend.ports.kill(4242);
      await backend.ports.scan(["/srv/repo"]);

      const execs = daemon.control
        .filter((r) => r.type === "exec")
        .map((r) => [r.cmd, r.args]);
      expect(execs).toContainEqual(["kill", ["-TERM", "4242"]]);
      expect(execs).toContainEqual(["id", ["-u"]]);
      expect(execs).toContainEqual([
        "/usr/sbin/lsof",
        ["-a", "-iTCP", "-sTCP:LISTEN", "-nP", "-F", "pcn", "-u", "1001"],
      ]);
      expect(killSpy).not.toHaveBeenCalled();
      killSpy.mockRestore();
    });

    it("never scans as root when the remote uid is unparseable", async () => {
      const { backend, daemon } = setup();
      current = backend;
      daemon.execReply = (req) => ({
        type: "execResult",
        stdout: req.cmd === "id" ? "id: cannot find name for user ID\n" : "",
        stderr: "",
        exitCode: 0,
      });
      await backend.connect();
      expect(await backend.ports.scan([])).toEqual([]);
      expect(daemon.control.some((r) => r.cmd === "/usr/sbin/lsof")).toBe(false);
    });
  });

  describe("exec streams", () => {
    it("keeps exec events away from the pty event handler", async () => {
      const { backend, daemon } = setup();
      current = backend;
      const ptyEvents: unknown[] = [];
      backend.pty.onEvent((e) => ptyEvents.push(e));
      await backend.connect();

      const onExit = vi.fn();
      backend.git.pushStream("/r", { branch: "main" }, { onLine: vi.fn(), onDone: onExit });
      await waitFor(() => daemon.stream.length > 0, "execStream");
      const execId = daemon.stream[0].execId as string;
      daemon.emit({ type: "execStdout", execId, data: "x" });
      daemon.emit({ type: "execExit", execId, exitCode: 0 });
      await waitFor(() => onExit.mock.calls.length > 0, "exit");
      expect(ptyEvents).toEqual([]);
    });

    it("cancel sends execCancel and the daemon's exit ends the stream", async () => {
      const { backend, daemon } = setup();
      current = backend;
      await backend.connect();
      const onDone = vi.fn();
      const { cancel } = backend.git.pushStream(
        "/r",
        { branch: "main" },
        { onLine: vi.fn(), onDone },
      );
      await waitFor(() => daemon.stream.length > 0, "execStream");
      cancel();
      await waitFor(() => onDone.mock.calls.length > 0, "done after cancel");
      expect(daemon.stream.map((c) => c.type)).toEqual(["execStream", "execCancel"]);
      expect(onDone).toHaveBeenCalledWith({ exitCode: null, stderr: "" });
    });

    it("ends a running stream with an error when the host drops", async () => {
      const { backend, daemon } = setup({ reconnectDelayMs: () => null });
      current = backend;
      await backend.connect();
      const onDone = vi.fn();
      backend.git.pushStream("/r", { branch: "main" }, { onLine: vi.fn(), onDone });
      await waitFor(() => daemon.stream.length > 0, "execStream");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      daemon.dropConnections();
      await waitFor(() => onDone.mock.calls.length > 0, "done after drop");
      expect(onDone).toHaveBeenCalledWith({
        exitCode: null,
        stderr: "Lost connection to the terminal host",
      });
      warn.mockRestore();
      error.mockRestore();
    });
  });

  describe("reconnect", () => {
    it("backs off 1s, 2s, 4s, 8s, 16s, then every 30s", () => {
      expect([0, 1, 2, 3, 4, 5, 6, 20].map(remoteReconnectDelayMs)).toEqual([
        1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
      ]);
    });

    it("emits hostDisconnected, retries on the backoff schedule, then hostReconnected", async () => {
      const { backend, daemon, transport, hostEvents } = setup();
      current = backend;
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await backend.connect();
      await backend.pty.createOrAttach("s1", "/srv/repo", 80, 24);
      const connectsBefore = transport.controlConnects;
      const subscribes = () => daemon.stream.filter((c) => c.type === "subscribe").length;
      // Subscribed twice by the create path (before the snapshot and after create).
      await waitFor(() => subscribes() === 2, "initial subscribes");

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      transport.unreachable = true;
      daemon.dropConnections();
      await waitForFake(() => hostEvents.length > 0);
      expect(hostEvents).toEqual([
        { type: "hostDisconnected", sessionIds: ["s1"], retryInMs: 1_000 },
      ]);

      // Attempt 1 fires at 1s, attempt 2 two seconds later, attempt 3 four after that.
      await vi.advanceTimersByTimeAsync(999);
      expect(transport.controlConnects - connectsBefore).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(transport.controlConnects - connectsBefore).toBe(1);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(transport.controlConnects - connectsBefore).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(transport.controlConnects - connectsBefore).toBe(2);
      await vi.advanceTimersByTimeAsync(3_999);
      expect(transport.controlConnects - connectsBefore).toBe(2);

      // The host comes back before attempt 3.
      transport.unreachable = false;
      await vi.advanceTimersByTimeAsync(1);
      expect(transport.controlConnects - connectsBefore).toBe(3);
      await waitForFake(() => hostEvents.length > 1);
      // The session survived: re-subscribed, and flagged for a resnapshot.
      expect(hostEvents[1]).toEqual({ type: "hostReconnected", sessionIds: ["s1"] });
      await waitForFake(() => subscribes() === 3);
      warn.mockRestore();
    });

    it("keeps retrying when the connection drops again while re-subscribing", async () => {
      const { backend, daemon, hostEvents } = setup({ reconnectDelayMs: () => 5 });
      current = backend;
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await backend.connect();
      await backend.pty.createOrAttach("s1", "/srv/repo", 80, 24);
      const subscribes = () => daemon.stream.filter((c) => c.type === "subscribe").length;
      await waitFor(() => subscribes() === 2, "initial subscribes");

      // The first reconnect gets as far as listing sessions, then ssh dies.
      daemon.dropOnListSessions = 1;
      daemon.dropConnections();
      await waitFor(() => hostEvents.length > 1, "hostReconnected");
      expect(daemon.dropOnListSessions).toBe(0);
      // Reported once: the second drop happened inside the loop.
      expect(hostEvents).toEqual([
        { type: "hostDisconnected", sessionIds: ["s1"], retryInMs: 5 },
        { type: "hostReconnected", sessionIds: ["s1"] },
      ]);
      await waitFor(() => subscribes() === 3, "re-subscribed");
      warn.mockRestore();
    });

    it.each([
      [
        "auth",
        () => new SshAuthError("user@box", "Permission denied (publickey)."),
        { reason: "auth" },
      ],
      [
        "bootstrap",
        () => new RemoteBootstrapError("node-missing", "Node.js 20 or newer is required"),
        { reason: "bootstrap", code: "node-missing" },
      ],
    ] as const)(
      "stops on a permanent %s failure, emits hostFailed, and recovers on an explicit connect",
      async (_label, makeError, expected) => {
        const { backend, daemon, transport, hostEvents } = setup({ reconnectDelayMs: () => 5 });
        current = backend;
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        await backend.connect();
        await backend.pty.createOrAttach("s1", "/srv/repo", 80, 24);
        const ensures = () => transport.ensureRunning.mock.calls.length;
        const before = ensures();

        transport.ensureRunning.mockImplementation(async () => {
          throw makeError();
        });
        daemon.dropConnections();
        await waitFor(() => hostEvents.some((e) => e.type === "hostFailed"), "hostFailed");
        expect(hostEvents[1]).toMatchObject({
          type: "hostFailed",
          sessionIds: ["s1"],
          ...expected,
        });
        expect(ensures() - before).toBe(1);
        await new Promise((r) => setTimeout(r, 50));
        expect(ensures() - before).toBe(1); // no retry loop

        // The session was not reported as exited, and an explicit connect
        // brings it back.
        transport.ensureRunning.mockImplementation(async () => {});
        await backend.connect();
        expect(hostEvents[2]).toEqual({ type: "hostReconnected", sessionIds: ["s1"] });
        expect(hostEvents).toHaveLength(3);
        warn.mockRestore();
        error.mockRestore();
      },
    );

    it("keeps retrying transient failures", async () => {
      const { backend, daemon, transport, hostEvents } = setup({ reconnectDelayMs: () => 5 });
      current = backend;
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await backend.connect();
      const before = transport.ensureRunning.mock.calls.length;
      transport.ensureRunning.mockImplementation(async () => {
        throw new Error("ssh to user@box failed while bootstrapping (exit 255)");
      });
      daemon.dropConnections();
      await waitFor(
        () => transport.ensureRunning.mock.calls.length - before >= 4,
        "several attempts",
      );
      expect(hostEvents.map((e) => e.type)).toEqual(["hostDisconnected"]);
      transport.ensureRunning.mockImplementation(async () => {});
      await waitFor(() => hostEvents.length > 1, "hostReconnected");
      expect(hostEvents[1].type).toBe("hostReconnected");
      warn.mockRestore();
    });

    it("stops retrying once disconnected on purpose", async () => {
      const { backend, daemon, transport } = setup();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await backend.connect();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      transport.unreachable = true;
      daemon.dropConnections();
      await vi.advanceTimersByTimeAsync(0);
      await backend.disconnect();
      const connects = transport.controlConnects;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(transport.controlConnects).toBe(connects);
      warn.mockRestore();
    });
  });
});

/** Poll under fake timers, where only microtasks and I/O move on their own. */
async function waitForFake(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !pred(); i++) {
    await new Promise<void>((r) => setImmediate(r));
  }
  if (!pred()) throw new Error("condition never held");
}
