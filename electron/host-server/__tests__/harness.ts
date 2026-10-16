/**
 * The host server's test harness (ADR-225 D1, D2): `runServe` against an
 * in-process daemon (`daemon-harness.ts`) in a temp `dataDir`, a `FakeRelay`
 * for its room, and the two ways in — the owner, over `server.sock` through
 * the real `HostServerClient`, and a phone, through the relay.
 *
 * PTY subprocesses are mocked, as in `terminal-host/e2e.test.ts`: the
 * sessions are real daemon sessions, their shells are not. The mocks live
 * here, so a test file imports this module before anything else.
 */

import { afterEach, beforeEach, expect, onTestFinished, vi } from "vitest";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { PassThrough, type Duplex } from "node:stream";
import { execFile } from "node:child_process";

import "../../terminal-host/xterm-env-polyfill";

/** The PTY subprocesses the daemon forked, in order (see `ptySubprocess`). */
const forked = vi.hoisted(
  () => [] as Array<{ stdin: PassThrough; stdout: PassThrough; written: Buffer[] }>,
);

vi.mock("node:child_process", () => ({
  fork: vi.fn(() => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const written: Buffer[] = [];
    stdin.on("data", (chunk: Buffer) => written.push(chunk));
    forked.push({ stdin, stdout, written });
    return { stdin, stdout, on: vi.fn(), kill: vi.fn(), pid: 77777 };
  }),
  // No secret helper exists here: the plaintext host's probe for a stronger
  // backend finds nothing and it stays on plaintext.
  spawn: vi.fn(() => {
    throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
  }),
  execFile: vi.fn(),
}));

vi.mock("../../shell", () => ({
  ShellManager: {
    zdotdirPath: () => "/tmp/manor-host-server-zdotdir",
    setupZdotdir: () => "/tmp/manor-host-server-zdotdir",
    realZdotdir: () => "",
    bashrcPath: () => "/tmp/manor-host-server-bashrc",
  },
}));

import {
  E2EDaemon,
  delay,
  makeTmpDir,
} from "../../terminal-host/daemon-harness";
import type { HostTransport } from "../../terminal-host/transport";
import { createLineReader } from "../../terminal-host/line-reader";
import { readPastServerHello } from "./hello-stream";
import { hostServerPaths, type HostServerPaths } from "../../paths";
import { HostServerClient } from "../../backend/host-server-client";
import { runServe, type RunningServer, type ServeOptions } from "../serve";
import { writeOwnership } from "../ownership";
import {
  FakeRelay,
  FakeViewer,
} from "../../remote-control/relay/__tests__/fake-relay";
import { base64urlDecode } from "../../../src/lib/relay-crypto";
import { WebSocket as WsWebSocket, type ClientOptions } from "ws";
import { FrameDecoder, MSG, encodeFrame } from "../../terminal-host/pty-subprocess-ipc";

export type Frame = Record<string, unknown>;

/**
 * The newest PTY subprocess the daemon forked, seen from the shell's side:
 * what the daemon typed into it, and a way to make the shell print (the
 * output a `writeAfterReady` waits for). Mocked, as the rest of the PTY is.
 */
export function ptySubprocess(): {
  /** Everything written to the terminal so far, as text. */
  typed(): string;
  /** The shell printed `data`: its first output makes it "ready". */
  output(data: string): void;
} {
  const sub = forked[forked.length - 1];
  if (!sub) throw new Error("no PTY subprocess was forked");
  return {
    typed() {
      let text = "";
      const decoder = new FrameDecoder((type, payload) => {
        if (type === MSG.WRITE) text += payload.toString("utf-8");
      });
      for (const chunk of sub.written) decoder.push(chunk);
      return text;
    },
    output(data) {
      sub.stdout.write(encodeFrame(MSG.DATA, data));
    },
  };
}

/** Sockets to an already-running `E2EDaemon`; nothing is ever spawned. */
export class HarnessTransport implements HostTransport {
  constructor(private readonly daemon: E2EDaemon) {}
  async ensureRunning(): Promise<void> {}
  async restart(): Promise<void> {
    throw new Error("the host server must never restart the daemon");
  }
  connectControl(): Promise<Duplex> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.daemon.socketPath, () =>
        resolve(socket),
      );
      socket.on("error", reject);
    });
  }
  connectStream(): Promise<Duplex> {
    return this.connectControl();
  }
  async authToken(): Promise<string> {
    return this.daemon.authToken;
  }
  async dispose(): Promise<void> {}
}

/**
 * Poll `read` until `ok` likes it; throw `timed out: <what>` otherwise. The
 * one polling helper: a boolean condition is `eventually(() => cond, Boolean, …)`.
 */
export async function eventually<T>(
  read: () => T | Promise<T>,
  ok: (value: T) => boolean,
  what: string,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await delay(20);
  }
}

/** A hook payload for `pane-1`, the pane the harness keeps a session for. */
export function hook(eventType: string, extra: Record<string, string> = {}) {
  return {
    paneId: "pane-1",
    eventType,
    kind: "claude",
    sessionId: "sess-1",
    ...extra,
  };
}

/** What a pairing link carries in its fragment. */
export function parsePairingUrl(url: string): {
  base: string;
  roomId: string;
  x25519Pub: string;
  token: string;
} {
  const match = /^(.*)#relay=([^.]+)\.([^&]+)&t=(.+)$/.exec(url);
  if (!match) throw new Error(`not a pairing link: ${url}`);
  return {
    base: match[1],
    roomId: match[2],
    x25519Pub: match[3],
    token: match[4],
  };
}

/**
 * No git in this test: every worktree listing fails at once, so a project
 * shows its main checkout, as on a box without the repo.
 */
export function withoutGit(): void {
  vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
    const callback = args[args.length - 1] as (err: Error) => void;
    setImmediate(() =>
      callback(
        Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }),
      ),
    );
    return {};
  }) as never);
  onTestFinished(() => {
    vi.mocked(execFile).mockReset();
  });
}

/**
 * Real git in this test: `execFile` runs the command, answering the way the
 * backends' `promisify(execFile)` of a plain mock reads it — one value,
 * `{ stdout, stderr }`.
 */
export async function withGit(): Promise<void> {
  const real =
    await vi.importActual<typeof import("node:child_process")>("node:child_process");
  vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
    const callback = args[args.length - 1] as (
      err: Error | null,
      out?: { stdout: string; stderr: string },
    ) => void;
    const [cmd, cmdArgs, opts] = args as [string, string[], object | undefined];
    return real.execFile(
      cmd,
      cmdArgs,
      { ...(typeof opts === "object" && opts !== null ? opts : {}), encoding: "utf-8" },
      (err, stdout, stderr) => callback(err, { stdout, stderr }),
    );
  }) as never);
  onTestFinished(() => {
    vi.mocked(execFile).mockReset();
  });
}

/**
 * One owner stream on `server.sock`, as `SshTransport.openServerBridge`
 * gives it: the owner hello sent, the server's reply read, the stream
 * handed over past it. Rejects when the server refuses the token.
 */
export async function openOwnerStream(
  socketPath: string,
  token: string,
): Promise<net.Socket> {
  const socket = await new Promise<net.Socket>((resolve, reject) => {
    const s = net.createConnection(socketPath, () => resolve(s));
    s.on("error", reject);
  });
  socket.write(JSON.stringify({ type: "hello", token }) + "\n");
  try {
    await readPastServerHello(socket);
  } catch (err) {
    socket.destroy();
    throw err;
  }
  return socket;
}

/** The owner: the real `HostServerClient`, plus the raw frames it ignores. */
export interface OwnerHandle {
  client: HostServerClient;
  /** Every frame the server sent after its hello, results included. */
  frames: Frame[];
  /** `ns.method(...args)`, untyped: for what is not on the host table too. */
  invoke<T = unknown>(
    ns: string,
    method: string,
    ...args: unknown[]
  ): Promise<T>;
  /**
   * Subscribe to a bridge event through the client, which keeps it across
   * reconnects; the events land in `frames`.
   */
  subscribe(ns: string, event: string): void;
  waitFor(match: (frame: Frame) => boolean): Promise<Frame>;
}

export interface PhoneHandle {
  viewer: FakeViewer;
  hello: Frame;
  call(ns: string, method: string, ...args: unknown[]): Promise<Frame>;
}

export interface HostServerHarness {
  readonly tmp: string;
  readonly daemon: E2EDaemon;
  readonly paths: HostServerPaths;
  readonly relay: FakeRelay;
  /** Web-push sends the server made, in order. */
  readonly pushes: Array<{ endpoint: string; payload: unknown }>;
  /** WebSockets the server's connector made. */
  readonly socketsMade: number;
  /** The server, if one is up. */
  readonly running: RunningServer | null;
  /** Start the server; `over` adds to (or replaces) the harness's options. */
  serve(over?: Partial<ServeOptions>): Promise<RunningServer>;
  /**
   * Mark the host adopted (ADR-227 D3) before the next `serve()`, as an
   * empty `hostServer.adopt` would: its project and layout writes open.
   */
  adopt(): void;
  /** Stop the running server (and forget it). */
  stop(): Promise<void>;
  /** Wait for the server's relay connector to hold its room. */
  relayUp(server: RunningServer): Promise<void>;
  owner(): Promise<OwnerHandle>;
  /** A phone: through the relay to the room in `pairingUrl`, hello'd. */
  phone(pairingUrl: string): Promise<PhoneHandle>;
}

/** Register the harness's setup and teardown on the calling `describe`. */
export function useHostServerHarness(): HostServerHarness {
  let tmp: string;
  let daemon: E2EDaemon;
  let paths: HostServerPaths;
  let relay: FakeRelay;
  let running: RunningServer | null = null;
  let pushes: Array<{ endpoint: string; payload: unknown }>;
  let socketsMade: number;
  const clients: HostServerClient[] = [];
  const viewers: FakeViewer[] = [];

  /** `ws`'s WebSocket, counted: what the server passes the connector. */
  class CountingWebSocket extends WsWebSocket {
    constructor(url: string, options: ClientOptions) {
      super(url, options);
      socketsMade += 1;
    }
  }

  beforeEach(async () => {
    relay = new FakeRelay();
    await relay.listen();
    pushes = [];
    socketsMade = 0;
    tmp = makeTmpDir();
    daemon = new E2EDaemon(path.join(tmp, "daemon"));
    await daemon.start();
    paths = hostServerPaths(path.join(tmp, "server"));
    fs.mkdirSync(paths.dataDir, { recursive: true });
    // Plaintext was "chosen" earlier; its upgrade probe finds no helper.
    fs.writeFileSync(
      paths.secretBackend,
      JSON.stringify({ backend: "plaintext" }),
    );
    // A live session for the agent's pane, so the boot sweep keeps it.
    daemon.getHost().create("pane-1", tmp, 80, 24);
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.dispose();
    for (const viewer of viewers.splice(0)) viewer.ws.terminate();
    await running?.stop();
    running = null;
    await daemon.stop();
    await relay.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  return {
    get tmp() {
      return tmp;
    },
    get daemon() {
      return daemon;
    },
    get paths() {
      return paths;
    },
    get relay() {
      return relay;
    },
    get pushes() {
      return pushes;
    },
    get socketsMade() {
      return socketsMade;
    },
    get running() {
      return running;
    },

    async serve(over = {}) {
      running = await runServe({
        dataDir: paths.dataDir,
        version: "1.2.3-test",
        transport: new HarnessTransport(daemon),
        logToFile: false,
        relay: {
          relayUrl: relay.url,
          webSocket: CountingWebSocket,
          timing: { backoffMinMs: 20, backoffMaxMs: 100 },
          pushSend: async (subscription, payload) => {
            pushes.push({
              endpoint: subscription.endpoint,
              payload: JSON.parse(String(payload)),
            });
            return { statusCode: 201, body: "", headers: {} };
          },
          pushGenerate: () => ({ publicKey: "vapid-pub", privateKey: "vapid" }),
        },
        ...over,
      });
      // The daemon is up, so `start()` (in `runServe`) has caught up.
      return running;
    },

    adopt() {
      writeOwnership(paths.ownership, "host");
    },

    async stop() {
      await running?.stop();
      running = null;
    },

    async relayUp(server) {
      await eventually(
        () => server.server.status().relay.connected,
        Boolean,
        "relay connected",
      );
    },

    async owner() {
      const token = fs.readFileSync(paths.ownerToken, "utf-8").trim();
      const frames: Frame[] = [];
      const client = new HostServerClient({
        hostId: "box",
        open: async () => {
          const socket = await openOwnerStream(paths.socket, token);
          socket.on(
            "data",
            createLineReader((line) => {
              frames.push(JSON.parse(line) as Frame);
            }),
          );
          // `awaitHelloLine` left it paused; the client's reader takes it from here.
          socket.resume();
          return socket;
        },
        requestTimeoutMs: 3_000,
        log: { info: () => {}, warn: () => {} },
      });
      clients.push(client);
      expect(await client.connect()).toBe(true);
      const namespaces = client.api as unknown as Record<
        string,
        Record<string, (...args: unknown[]) => Promise<unknown>>
      >;
      return {
        client,
        frames,
        invoke: async <T>(ns: string, method: string, ...args: unknown[]) =>
          (await namespaces[ns][method](...args)) as T,
        subscribe: (ns, event) => {
          client.subscribe(ns, event, undefined, () => {});
        },
        waitFor: (match) =>
          eventually(
            () => frames.find(match),
            Boolean,
            "a frame",
            3_000,
          ) as Promise<Frame>,
      };
    },

    async phone(pairingUrl) {
      const link = parsePairingUrl(pairingUrl);
      const viewer = await FakeViewer.open(
        relay.url,
        link.roomId,
        base64urlDecode(link.x25519Pub),
      );
      viewers.push(viewer);
      viewer.send({ type: "hello", token: link.token });
      const hello = await viewer.next((f) => f.type === "hello");
      expect(hello).toMatchObject({ ok: true });
      let nextId = 1;
      return {
        viewer,
        hello,
        async call(ns, methodName, ...args) {
          const id = nextId++;
          viewer.send({ kind: "invoke", id, ns, method: methodName, args });
          return viewer.next((f) => f.kind === "result" && f.id === id);
        },
      };
    },
  };
}
