/**
 * ADR-178's bridge, tested over a real socket against a real listener, for the
 * reason `server.test.ts` gives: the properties are transport-level. "A `send`
 * device is closed with 4403" is only true if the upgrade, the hello and the
 * tier check are wired to each other, and a unit-level call to
 * `WsBridgeServer` would let any of those three come loose and still pass.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";

import { RemoteControlServer, type AuthenticatedDevice } from "../server";
import { RemoteAuditLog } from "../audit";
import { AuthRateLimiter } from "../rate-limit";
import { WsBridgeServer } from "../ws-bridge-server";
import type { IpcDeps } from "../../ipc/types";
import type { ControlDeps } from "../../routes/types";

const READ_TOKEN = "read-token";
const SEND_TOKEN = "send-token";
const FULL_TOKEN = "full-token";

const reader: AuthenticatedDevice = {
  id: "dev-read",
  label: "phone",
  capability: "read",
};
const sender: AuthenticatedDevice = {
  id: "dev-send",
  label: "phone (send)",
  capability: "send",
};
const everything: AuthenticatedDevice = {
  id: "dev-full",
  label: "laptop browser",
  capability: "full",
};

const devices = {
  verify: (raw: unknown) => {
    if (raw === READ_TOKEN) return reader;
    if (raw === SEND_TOKEN) return sender;
    if (raw === FULL_TOKEN) return everything;
    return null;
  },
};

/** Every frame a socket received, plus the close code if it closed. */
interface Client {
  socket: WebSocket;
  frames: Record<string, unknown>[];
  closed: Promise<number>;
  send(frame: unknown): void;
  /** Resolves with the first frame matching `match`, or rejects on close. */
  next(match: (f: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>;
}

describe("WsBridgeServer", () => {
  let server: RemoteControlServer;
  let bridge: WsBridgeServer;
  let deps: IpcDeps;
  let auditDir: string;
  let audit: RemoteAuditLog;
  let port: number;
  let clients: Client[];
  let written: Array<[string, string]>;
  let created: string[];

  beforeEach(async () => {
    auditDir = fs.mkdtempSync(path.join(os.tmpdir(), "manor-ws-audit-"));
    audit = new RemoteAuditLog(path.join(auditDir, "remote-audit.jsonl"));
    clients = [];
    written = [];
    created = [];

    // Enough of `IpcDeps` for the handlers this file exercises. The cast is
    // the point: the bridge takes the real deps object, and a test that
    // rebuilt all 25 managers would be testing the fixture.
    deps = {
      backend: {
        pty: {
          createOrAttach: async (paneId: string) => {
            created.push(paneId);
            return { snapshot: null };
          },
          write: (paneId: string, data: string) => {
            written.push([paneId, data]);
          },
        },
      },
      preferencesManager: {
        getAll: () => ({ notifyOnRequiresInput: true }),
      },
      projectManager: {
        getProjects: () => [{ id: "p1", name: "manor", workspaces: [] }],
        getSelectedProjectIndex: () => 0,
        selectProject: () => {},
      },
    } as unknown as IpcDeps;

    bridge = new WsBridgeServer(deps, { audit });
    server = new RemoteControlServer(
      () => ({}) as unknown as ControlDeps,
      devices,
      {
        limiter: new AuthRateLimiter(),
        audit,
        clientDir: null,
        webDir: null,
        push: null,
        bridge,
      },
    );
    ({ port } = await server.start());
  });

  afterEach(async () => {
    for (const client of clients) client.socket.terminate();
    bridge.dispose();
    await server.stop();
    fs.rmSync(auditDir, { recursive: true, force: true });
  });

  /** Open a socket and start collecting frames. Does not say hello. */
  function connect(): Client {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const frames: Record<string, unknown>[] = [];
    const waiters: Array<{
      match: (f: Record<string, unknown>) => boolean;
      resolve: (f: Record<string, unknown>) => void;
      reject: (err: Error) => void;
    }> = [];

    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
      frames.push(frame);
      for (const waiter of [...waiters]) {
        if (!waiter.match(frame)) continue;
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(frame);
      }
    });

    const closed = new Promise<number>((resolve) => {
      socket.on("close", (code) => {
        for (const waiter of waiters.splice(0)) {
          waiter.reject(new Error(`socket closed with ${code}`));
        }
        resolve(code);
      });
    });

    const client: Client = {
      socket,
      frames,
      closed,
      send(frame) {
        socket.send(JSON.stringify(frame));
      },
      next(match) {
        const already = frames.find(match);
        if (already) return Promise.resolve(already);
        return new Promise((resolve, reject) => {
          waiters.push({ match, resolve, reject });
        });
      },
    };
    clients.push(client);
    return client;
  }

  /** Open, say hello with `token`, and wait for the reply frame. */
  async function greet(token: string): Promise<Client> {
    const client = connect();
    await new Promise<void>((resolve, reject) => {
      client.socket.once("open", resolve);
      client.socket.once("error", reject);
    });
    client.send({ type: "hello", token });
    return client;
  }

  async function invoke(
    client: Client,
    id: string,
    ns: string,
    method: string,
    args: unknown[] = [],
  ): Promise<Record<string, unknown>> {
    client.send({ id, kind: "invoke", ns, method, args });
    return client.next((f) => f.kind === "result" && f.id === id);
  }

  describe("hello", () => {
    it("closes a bad token with 4401", async () => {
      const client = await greet("not-a-real-token");
      expect(await client.closed).toBe(4401);
    });

    it("closes a send device with 4403", async () => {
      const client = await greet(SEND_TOKEN);
      expect(await client.closed).toBe(4403);
    });

    it("closes a read device with 4403", async () => {
      const client = await greet(READ_TOKEN);
      expect(await client.closed).toBe(4403);
    });

    it("answers a full device with the protocol version", async () => {
      const client = await greet(FULL_TOKEN);
      const hello = await client.next((f) => f.type === "hello");
      expect(hello).toMatchObject({ type: "hello", ok: true, v: 1 });
    });

    it("refuses to do anything before the hello lands", async () => {
      const client = connect();
      await new Promise<void>((resolve) => client.socket.once("open", resolve));
      client.send({ id: "1", kind: "invoke", ns: "projects", method: "getAll" });
      // Not a hello, so it is not a conversation this server is having.
      expect(await client.closed).toBe(4401);
    });

    it("upgrades nothing outside /ws", async () => {
      const stray = new WebSocket(`ws://127.0.0.1:${port}/events`);
      await new Promise<void>((resolve) => {
        stray.once("error", () => resolve());
        stray.once("close", () => resolve());
      });
      expect(stray.readyState).toBe(WebSocket.CLOSED);
    });
  });

  describe("invoke", () => {
    it("resolves a method the table implements", async () => {
      const client = await greet(FULL_TOKEN);
      const result = await invoke(client, "a", "projects", "getAll");
      expect(result).toMatchObject({ id: "a", kind: "result", ok: true });
      expect(result.result).toEqual([
        { id: "p1", name: "manor", workspaces: [] },
      ]);
    });

    it("rejects a method the table does not implement", async () => {
      const client = await greet(FULL_TOKEN);
      const result = await invoke(client, "b", "webview", "capture");
      expect(result).toMatchObject({
        id: "b",
        kind: "result",
        ok: false,
        code: "unavailable:web",
      });
    });

    it("rejects an absent namespace the same way as an absent method", async () => {
      const client = await greet(FULL_TOKEN);
      const result = await invoke(client, "c", "dialog", "openDirectory");
      expect(result).toMatchObject({ ok: false, code: "unavailable:web" });
    });

    it("refuses layout.save by name rather than dropping it", async () => {
      const client = await greet(FULL_TOKEN);
      const result = await invoke(client, "d", "layout", "save", [{}]);
      expect(result).toMatchObject({ ok: false, code: "unavailable:web" });
      expect(String(result.error)).toContain("ADR-178, slice 2");
    });

    it("reports a handler that threw without claiming to be unavailable", async () => {
      const client = await greet(FULL_TOKEN);
      // `assertString` rejects the number, from inside the lifted handler —
      // the same validation the desktop's `ipcMain.handle` wrapper runs.
      const result = await invoke(client, "e", "pty", "write", [1, "x"]);
      expect(result).toMatchObject({ ok: false, code: "failed" });
      expect(written).toEqual([]);
    });

    it("reaches the same code the desktop's ipc handler reaches", async () => {
      const client = await greet(FULL_TOKEN);
      await invoke(client, "f", "pty", "write", ["pane-a", "ls\r"]);
      expect(written).toEqual([["pane-a", "ls\r"]]);
    });
  });

  describe("events", () => {
    it("forwards a subscribed pane's output and no other pane's", async () => {
      const client = await greet(FULL_TOKEN);
      await client.next((f) => f.type === "hello");
      client.send({
        kind: "subscribe",
        ns: "pty",
        event: "output",
        key: "pane-a",
      });
      // Give the subscribe frame a turn before the events race it.
      await invoke(client, "sync", "projects", "getAll");

      bridge.handleStreamEvent({
        type: "data",
        sessionId: "pane-b",
        data: "not mine",
      });
      bridge.handleStreamEvent({
        type: "data",
        sessionId: "pane-a",
        data: "mine",
        seq: 7,
      });

      const event = await client.next((f) => f.kind === "event");
      expect(event).toMatchObject({
        kind: "event",
        ns: "pty",
        event: "output",
        args: ["mine", 7],
      });
      const outputs = client.frames.filter((f) => f.kind === "event");
      expect(outputs).toHaveLength(1);
    });

    it("stops forwarding after unsubscribe", async () => {
      const client = await greet(FULL_TOKEN);
      client.send({
        kind: "subscribe",
        ns: "pty",
        event: "exit",
        key: "pane-a",
      });
      await invoke(client, "sync", "projects", "getAll");
      client.send({
        kind: "unsubscribe",
        ns: "pty",
        event: "exit",
        key: "pane-a",
      });
      await invoke(client, "sync2", "projects", "getAll");

      bridge.handleStreamEvent({
        type: "exit",
        sessionId: "pane-a",
        exitCode: 0,
      });
      await invoke(client, "sync3", "projects", "getAll");
      expect(client.frames.filter((f) => f.kind === "event")).toEqual([]);
    });

    it("forwards a resize with the preload's argument shape", async () => {
      const client = await greet(FULL_TOKEN);
      client.send({
        kind: "subscribe",
        ns: "pty",
        event: "resized",
        key: "pane-a",
      });
      await invoke(client, "sync", "projects", "getAll");

      bridge.handleStreamEvent({
        type: "resized",
        sessionId: "pane-a",
        cols: 120,
        rows: 40,
      });
      const event = await client.next((f) => f.kind === "event");
      expect(event.args).toEqual([120, 40]);
    });

    it("sends nothing to a socket that never subscribed", async () => {
      const client = await greet(FULL_TOKEN);
      await invoke(client, "sync", "projects", "getAll");
      bridge.handleStreamEvent({
        type: "data",
        sessionId: "pane-a",
        data: "x",
      });
      await invoke(client, "sync2", "projects", "getAll");
      expect(client.frames.filter((f) => f.kind === "event")).toEqual([]);
    });
  });

  describe("audit", () => {
    it("writes one line for a session-creating invoke", async () => {
      const client = await greet(FULL_TOKEN);
      await invoke(client, "g", "pty", "create", ["pane-a", null, 80, 24]);
      expect(created).toEqual(["pane-a"]);

      const entries = audit.read();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        tier: "full",
        transport: "bridge",
        deviceId: everything.id,
        deviceLabel: everything.label,
        route: "pty.create",
        target: "pane-a",
        outcome: "sent",
        textLength: null,
        textSha256: null,
      });
    });

    it("writes no line for a keystroke, and none for a read", async () => {
      const client = await greet(FULL_TOKEN);
      await invoke(client, "h", "pty", "write", ["pane-a", "sk-secret"]);
      await invoke(client, "i", "projects", "getAll");
      expect(written).toEqual([["pane-a", "sk-secret"]]);
      expect(audit.read()).toEqual([]);
    });
  });

  describe("shutdown", () => {
    it("closes every open socket when the listener stops", async () => {
      const a = await greet(FULL_TOKEN);
      const b = await greet(FULL_TOKEN);
      await a.next((f) => f.type === "hello");
      await b.next((f) => f.type === "hello");
      expect(bridge.size).toBe(2);

      await server.stop();
      await Promise.all([a.closed, b.closed]);
      expect(bridge.size).toBe(0);
    });
  });
});
