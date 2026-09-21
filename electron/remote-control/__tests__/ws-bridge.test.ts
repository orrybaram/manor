/**
 * ADR-178's bridge, tested over a real socket against a real listener, for the
 * reason `server.test.ts` gives: the properties are transport-level. "A `send`
 * device is closed with 4403" is only true if the upgrade, the hello and the
 * tier check are wired to each other, and a unit-level call to
 * `WsBridgeServer` would let any of those three come loose and still pass.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";

import { RemoteControlServer, type AuthenticatedDevice } from "../server";
import { RemoteAuditLog } from "../audit";
import { AuthRateLimiter } from "../rate-limit";
import { WsBridgeServer } from "../../bridge/transports/ws";
import {
  attach,
  release,
  resetAttachments,
  type Viewer,
} from "../../pty-attachments";

/**
 * A renderer window, as `pty-attachments.ts` now sees one (ADR-180 D6): a
 * connection id — `webContents.id` as a string — and the class of caller it
 * is. `local` is what outranks the sockets these tests open.
 */
const DESKTOP_WINDOW: Viewer = { connectionId: "1", callerClass: "local" };
import { publishRendererBroadcast } from "../../renderer-broadcast";
import { LayoutStore } from "../../layout/layout-store";
import { LayoutPersistence } from "../../terminal-host/layout-persistence";
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
  next(
    match: (f: Record<string, unknown>) => boolean,
  ): Promise<Record<string, unknown>>;
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
  /** `[paneId, cols, rows]` — the size a create actually reached the daemon with. */
  let createdAt: Array<[string, number, number]>;
  let resized: Array<[string, number, number]>;
  let killed: string[];
  /** The grid the daemon reports for any session, or none. */
  let sessionSize: { cols: number; rows: number } | null;
  /** `[key, value]` pairs `preferences.set` actually reached the manager with. */
  let preferencesSet: Array<[string, unknown]>;
  /** ADR-179's layout authority, real: `layout.apply` has to reach a reducer. */
  let layoutStore: LayoutStore;

  beforeEach(async () => {
    auditDir = fs.mkdtempSync(path.join(os.tmpdir(), "manor-ws-audit-"));
    audit = new RemoteAuditLog(path.join(auditDir, "remote-audit.jsonl"));
    clients = [];
    written = [];
    created = [];
    createdAt = [];
    resized = [];
    killed = [];
    sessionSize = null;
    preferencesSet = [];
    resetAttachments();

    // Real store, real reducer, real file: `layout.apply` over the socket is
    // only interesting if it ends in a broadcast the socket can hear.
    layoutStore = new LayoutStore(
      new LayoutPersistence(path.join(auditDir, "layout.json")),
      (payload) => publishRendererBroadcast("layout", "changed", payload),
      { pty: { kill: async () => {} } } as never,
    );

    // Enough of `IpcDeps` for the handlers this file exercises. The cast is
    // the point: the bridge takes the real deps object, and a test that
    // rebuilt all 25 managers would be testing the fixture.
    deps = {
      backend: {
        pty: {
          createOrAttach: async (
            paneId: string,
            _cwd: string,
            cols: number,
            rows: number,
          ) => {
            created.push(paneId);
            createdAt.push([paneId, cols, rows]);
            return { snapshot: null };
          },
          write: (paneId: string, data: string) => {
            written.push([paneId, data]);
          },
          resize: async (paneId: string, cols: number, rows: number) => {
            resized.push([paneId, cols, rows]);
          },
          kill: async (paneId: string) => {
            killed.push(paneId);
          },
          detach: async () => {},
          disposeDead: async () => {},
          // The session's real grid, as the daemon holds it: what a follower
          // is told to render, and what the desktop is already rendering.
          getSnapshot: async (paneId: string) =>
            sessionSize ? { screenAnsi: "", ...sessionSize, sessionId: paneId } : null,
        },
      },
      preferencesManager: {
        getAll: () => ({ notifyOnRequiresInput: true }),
        set: (key: string, value: unknown) => {
          preferencesSet.push([key, value]);
        },
      },
      paneContextMap: new Map(),
      get layoutStore() {
        return layoutStore;
      },
      projectManager: {
        getProjects: () => [{ id: "p1", name: "manor", workspaces: [] }],
        getSelectedProjectIndex: () => 0,
        selectProject: () => {},
      },
      remoteControl: {
        status: () => ({
          enabled: true,
          port: 4177,
          devices: [
            {
              id: "dev-full",
              label: "laptop browser",
              capability: "full",
              createdAt: "2024-01-01T00:00:00.000Z",
              lastSeenAt: null,
              hasPush: false,
            },
          ],
          tunnel: { state: "stopped", kind: null, url: null, error: null },
          detected: { tailscale: false, cloudflared: false },
          encryptionAvailable: true,
          listeners: 1,
        }),
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
      client.send({
        id: "1",
        kind: "invoke",
        ns: "projects",
        method: "getAll",
      });
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

    /**
     * ADR-179 ticket 4's report: a reconnecting client's id used to change
     * every time, dropping a selection hint addressed to the id it had
     * before, and resetting its `pty-attachments` viewer identity as if it
     * were a brand new tab.
     */
    it("reuses the id a client says it held before, when nothing else is using it", async () => {
      const client = connect();
      await new Promise<void>((resolve) => client.socket.once("open", resolve));
      client.send({
        type: "hello",
        token: FULL_TOKEN,
        previousId: "bridge-was-here",
      });
      const hello = await client.next((f) => f.type === "hello");
      expect(hello.rendererId).toBe("bridge-was-here");
    });

    it("refuses a previous id a live connection is still using", async () => {
      const holder = await greet(FULL_TOKEN);
      const helloA = await holder.next((f) => f.type === "hello");
      const heldId = helloA.rendererId as string;

      const claimant = connect();
      await new Promise<void>((resolve) =>
        claimant.socket.once("open", resolve),
      );
      claimant.send({ type: "hello", token: FULL_TOKEN, previousId: heldId });
      const helloB = await claimant.next((f) => f.type === "hello");
      expect(helloB.rendererId).not.toBe(heldId);
      expect(typeof helloB.rendererId).toBe("string");
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

    /**
     * The read a `full` device needs to see who else is paired, added
     * alongside its status broadcast (ADR-178 ticket 9). Reads only —
     * `setEnabled`/`pair`/`revoke`/tunnel stay off the table.
     */
    it("resolves remoteControl.getStatus for a full device", async () => {
      const client = await greet(FULL_TOKEN);
      const result = await invoke(client, "rc1", "remoteControl", "getStatus");
      expect(result).toMatchObject({ ok: true });
      expect(result.result).toMatchObject({
        enabled: true,
        listeners: 1,
        devices: [{ id: "dev-full", capability: "full" }],
      });
    });

    /**
     * A `full` device may write preferences (D3) — off the slice-1 table for
     * scope, not policy.
     */
    it("resolves preferences.set and reaches the manager", async () => {
      const client = await greet(FULL_TOKEN);
      const result = await invoke(client, "ps1", "preferences", "set", [
        "notifyOnResponse",
        false,
      ]);
      expect(result).toMatchObject({ ok: true });
      expect(preferencesSet).toEqual([["notifyOnResponse", false]]);
    });

    /**
     * A pane opened from a browser needs the same project/workspace context
     * as one opened on the desktop (ADR-178 ticket 10) — otherwise the
     * sidebar's per-pane agent metadata has nothing to point at.
     */
    it("resolves agents.setPaneContext and reaches the map", async () => {
      const client = await greet(FULL_TOKEN);
      const result = await invoke(client, "spc1", "agents", "setPaneContext", [
        "pane-a",
        {
          projectId: "p1",
          projectName: "manor",
          workspacePath: "/home/user/manor",
          agentCommand: "claude",
        },
      ]);
      expect(result).toMatchObject({ ok: true });
      expect(deps.paneContextMap.get("pane-a")).toEqual({
        projectId: "p1",
        projectName: "manor",
        workspacePath: "/home/user/manor",
        agentCommand: "claude",
      });
    });

    /** `keybindings.set`/`reset`/`resetAll` stay off — that page is read-only on web. */
    it("keeps keybindings.set off the table", async () => {
      const client = await greet(FULL_TOKEN);
      const result = await invoke(client, "kb1", "keybindings", "set", [
        "new-tab",
        "cmd+t",
      ]);
      expect(result).toMatchObject({ ok: false, code: "unavailable:web" });
    });

    /** ADR-179 ticket 3 deleted the renderer's save path; nothing serves it. */
    it("has no layout.save at all", async () => {
      const client = await greet(FULL_TOKEN);
      const result = await invoke(client, "d", "layout", "save", [{}]);
      expect(result).toMatchObject({ ok: false, code: "unavailable:web" });
    });

    /**
     * ADR-179 D7: arranging panes from a browser is an ordinary command that
     * shows up on the desk. The answer is a version, never a layout — the
     * layout arrives on `layout.changed`, at every renderer at once.
     */
    it("applies a layout command and answers with the new version", async () => {
      const client = await greet(FULL_TOKEN);
      const result = await invoke(client, "l1", "layout", "apply", [
        "/project/main",
        {
          type: "new-tab",
          tab: {
            id: "tab-1",
            title: "Terminal",
            rootNode: { type: "leaf", paneId: "pane-1" },
          },
        },
      ]);

      expect(result).toMatchObject({ ok: true, result: { version: 1 } });
      expect(
        Object.values(layoutStore.get("/project/main")!.layout.panels)[0].tabs,
      ).toHaveLength(1);
    });

    /**
     * ADR-179 ticket 11: "a new tab running `pnpm dev`" from a browser is two
     * calls — the line, then the tab — and the line waits in the server's map
     * until whichever renderer mounts the pane reaches `pty.create`.
     */
    it("queues a pending command for a pane the browser is about to create", async () => {
      const client = await greet(FULL_TOKEN);
      const result = await invoke(
        client,
        "pc1",
        "layout",
        "setPendingCommand",
        ["pane-new", "pnpm dev", "shell"],
      );

      expect(result).toMatchObject({ ok: true });
      expect(layoutStore.pendingCommands.take("pane-new")).toEqual({
        text: "pnpm dev",
        kind: "shell",
      });
    });

    it("refuses a pending command with an unknown kind", async () => {
      const client = await greet(FULL_TOKEN);
      const result = await invoke(
        client,
        "pc2",
        "layout",
        "setPendingCommand",
        ["pane-new", "pnpm dev", "sudo"],
      );

      expect(result).toMatchObject({ ok: false, code: "failed" });
      expect(layoutStore.pendingCommands.size).toBe(0);
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
        // Which pane, for a client whose one socket carries several.
        key: "pane-a",
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

    /**
     * The second sink `renderer-broadcast.ts` exists for: a change the
     * desktop windows learn about via `webContents.send` reaches a
     * subscribed browser the same way (ADR-178 ticket 9).
     */
    it("forwards a remoteControl.status broadcast to a subscribed socket", async () => {
      const client = await greet(FULL_TOKEN);
      client.send({ kind: "subscribe", ns: "remoteControl", event: "status" });
      await invoke(client, "sync", "projects", "getAll");

      publishRendererBroadcast("remoteControl", "status", {
        enabled: true,
        listeners: 2,
      });

      const event = await client.next((f) => f.kind === "event");
      expect(event).toMatchObject({
        kind: "event",
        ns: "remoteControl",
        event: "status",
        args: [{ enabled: true, listeners: 2 }],
      });
    });

    /** ADR-179 D1: the sender hears its own change, the same way everyone
     *  else does — there is no optimistic apply on either side. */
    it("delivers layout.changed to a subscribed socket", async () => {
      const client = await greet(FULL_TOKEN);
      client.send({ kind: "subscribe", ns: "layout", event: "changed" });
      await invoke(client, "sync", "projects", "getAll");

      await invoke(client, "l2", "layout", "apply", [
        "/project/main",
        {
          type: "new-tab",
          tab: {
            id: "tab-1",
            title: "Terminal",
            rootNode: { type: "leaf", paneId: "pane-1" },
          },
        },
      ]);

      const event = await client.next((f) => f.kind === "event");
      expect(event).toMatchObject({
        kind: "event",
        ns: "layout",
        event: "changed",
      });
      const payload = (event.args as [Record<string, unknown>])[0];
      expect(payload).toMatchObject({
        workspacePath: "/project/main",
        version: 1,
        claims: [],
      });
      expect(JSON.stringify(payload.layout)).toContain("pane-1");
      // The origin is the socket's, not the frame's: a browser cannot claim
      // to be another renderer and collect its selection hints (ADR-179 D3).
      const origin = payload.origin as { kind: string; id: string };
      expect(origin.kind).toBe("bridge");
      expect(origin.id).toMatch(/^bridge-/);
      expect(payload.hint).toMatchObject({ selectTab: { tabId: "tab-1" } });
    });

    it("names the socket in its hello reply", async () => {
      const client = await greet(FULL_TOKEN);

      // The same id every `layout.apply` from this socket carries, so the tab
      // can tell its own broadcast from every other viewer's (ADR-179 D3).
      const hello = await client.next((f) => f.type === "hello");
      expect(hello.rendererId).toMatch(/^bridge-/);
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

    it("audits layout.apply with the workspace as its target", async () => {
      const client = await greet(FULL_TOKEN);
      await invoke(client, "l3", "layout", "apply", [
        "/project/main",
        { type: "close-tab", tabId: "tab-gone" },
      ]);

      const entries = audit.read();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        transport: "bridge",
        route: "layout.apply",
        target: "/project/main",
        outcome: "sent",
      });
    });

    it("audits preferences.set with the key as its target, never the value", async () => {
      const client = await greet(FULL_TOKEN);
      await invoke(client, "ps-audit", "preferences", "set", [
        "notifyOnResponse",
        false,
      ]);

      const entries = audit.read();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        route: "preferences.set",
        target: "notifyOnResponse",
        outcome: "sent",
      });
    });

    it("audits agents.setPaneContext with the paneId as its target", async () => {
      const client = await greet(FULL_TOKEN);
      await invoke(client, "spc-audit", "agents", "setPaneContext", [
        "pane-a",
        {
          projectId: "p1",
          projectName: "manor",
          workspacePath: "/home/user/manor",
          agentCommand: "claude",
        },
      ]);

      const entries = audit.read();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        route: "agents.setPaneContext",
        target: "pane-a",
        outcome: "sent",
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

  /**
   * ADR-178 D5. The bridge is the one place that knows a caller is a *web*
   * viewer, so it is the one place that can answer "who owns the winsize" —
   * and the answer has to be carried on the create reply, because by the time
   * the browser could ask separately it has already fitted itself.
   */
  describe("follower mode", () => {
    const PANE = "pane-a";

    it("tells a browser it owns the winsize when no desktop window does", async () => {
      const client = await greet(FULL_TOKEN);
      const result = await invoke(client, "c1", "pty", "create", [
        PANE,
        null,
        100,
        30,
      ]);
      expect(result).toMatchObject({ ok: true });
      expect(result.result).toMatchObject({
        ok: true,
        winsizeOwner: true,
        cols: 100,
        rows: 30,
      });
      expect(createdAt).toEqual([[PANE, 100, 30]]);
    });

    it("tells a browser it is a follower, and hands it the owner's grid", async () => {
      attach(PANE, DESKTOP_WINDOW);
      sessionSize = { cols: 160, rows: 45 };
      const client = await greet(FULL_TOKEN);
      const result = await invoke(client, "c2", "pty", "create", [
        PANE,
        null,
        100,
        30,
      ]);
      expect(result.result).toMatchObject({
        ok: true,
        winsizeOwner: false,
        cols: 160,
        rows: 45,
      });
    });

    /**
     * The one that would have shipped the bug. `createOrAttach` resizes before
     * it snapshots, so a browser merely *looking* at a desktop-owned pane would
     * have resized it — through the call it has to make to see anything.
     */
    it("does not carry a browser's grid into a create on a desktop-owned pane", async () => {
      attach(PANE, DESKTOP_WINDOW);
      sessionSize = { cols: 160, rows: 45 };
      const client = await greet(FULL_TOKEN);
      await invoke(client, "c3", "pty", "create", [PANE, null, 100, 30]);
      expect(createdAt).toEqual([[PANE, 160, 45]]);
    });

    it("drops a follower's resize instead of refusing it", async () => {
      attach(PANE, DESKTOP_WINDOW);
      const client = await greet(FULL_TOKEN);
      const result = await invoke(client, "r1", "pty", "resize", [
        PANE,
        100,
        30,
      ]);
      // Resolved, not rejected: a follower asking is not an error, and a
      // rejection would be logged on every layout tick.
      expect(result).toMatchObject({ ok: true });
      expect(resized).toEqual([]);
    });

    it("resizes normally when the browser is the only viewer", async () => {
      const client = await greet(FULL_TOKEN);
      await invoke(client, "r2", "pty", "resize", [PANE, 100, 30]);
      expect(resized).toEqual([[PANE, 100, 30]]);
    });

    it("decorates pty.reset the same way, being create-shaped", async () => {
      attach(PANE, DESKTOP_WINDOW);
      sessionSize = { cols: 160, rows: 45 };
      const client = await greet(FULL_TOKEN);
      const result = await invoke(client, "x1", "pty", "reset", [
        PANE,
        null,
        100,
        30,
      ]);
      expect(result.result).toMatchObject({
        ok: true,
        winsizeOwner: false,
        cols: 160,
        rows: 45,
      });
      expect(killed).toEqual([PANE]);
      expect(createdAt).toEqual([[PANE, 160, 45]]);
    });

    it("keeps pty.consumePrewarmed off the table", async () => {
      const client = await greet(FULL_TOKEN);
      const result = await invoke(client, "x2", "pty", "consumePrewarmed");
      expect(result).toMatchObject({ ok: false, code: "unavailable:web" });
    });
  });

  /**
   * ADR-179 D6: with no desktop window in the picture, the most recently
   * attached bridge viewer owns a pane's winsize, and everyone else that is
   * watching it hears about a change live rather than on their next create.
   */
  describe("winsize ownership (D6)", () => {
    const PANE = "pane-a";

    async function watch(client: Client): Promise<void> {
      client.send({
        kind: "subscribe",
        ns: "pty",
        event: "winsizeOwner",
        key: PANE,
      });
      await invoke(client, `sync-${Math.random()}`, "projects", "getAll");
    }

    function ownerEvents(client: Client): Record<string, unknown>[] {
      return client.frames.filter(
        (f) => f.kind === "event" && f.event === "winsizeOwner",
      );
    }

    /**
     * Every `Client` accumulates frames rather than draining them (`next`
     * re-finds the first match forever), and a socket subscribed the whole
     * time hears about *its own* attach as an ownership change too. So
     * assertions are made against "the Nth event this client has seen" —
     * waited for by polling the buffer rather than raced against a single
     * `next` — instead of "the next one", which would just keep resolving
     * with the first.
     */
    async function ownerEventsAtLeast(
      client: Client,
      count: number,
    ): Promise<Record<string, unknown>[]> {
      await vi.waitFor(() => {
        if (ownerEvents(client).length < count) {
          throw new Error(`only ${ownerEvents(client).length} of ${count} so far`);
        }
      });
      return ownerEvents(client);
    }

    it("makes the second bridge viewer the owner and tells the first it is now a follower", async () => {
      sessionSize = { cols: 80, rows: 24 };
      const first = await greet(FULL_TOKEN);
      await watch(first);
      const created1 = await invoke(first, "c1", "pty", "create", [
        PANE,
        null,
        80,
        24,
      ]);
      expect(created1.result).toMatchObject({ winsizeOwner: true });
      // `first` becoming the pane's very first viewer is itself an ownership
      // change it hears about.
      await ownerEventsAtLeast(first, 1);

      const second = await greet(FULL_TOKEN);
      await watch(second);
      sessionSize = { cols: 120, rows: 40 };
      const created2 = await invoke(second, "c2", "pty", "create", [
        PANE,
        null,
        120,
        40,
      ]);
      expect(created2.result).toMatchObject({ winsizeOwner: true });

      const events = await ownerEventsAtLeast(first, 2);
      expect(events[1]).toMatchObject({
        ns: "pty",
        event: "winsizeOwner",
        key: PANE,
        args: [{ paneId: PANE, cols: 120, rows: 40, owner: false }],
      });
    });

    it("tells every bridge viewer it is a follower once a desktop attaches", async () => {
      sessionSize = { cols: 100, rows: 30 };
      const first = await greet(FULL_TOKEN);
      await watch(first);
      await invoke(first, "c1", "pty", "create", [PANE, null, 100, 30]);
      await ownerEventsAtLeast(first, 1); // its own attach

      const second = await greet(FULL_TOKEN);
      await watch(second);
      await invoke(second, "c2", "pty", "create", [PANE, null, 100, 30]);
      await ownerEventsAtLeast(first, 2); // lost ownership to `second`
      await ownerEventsAtLeast(second, 1); // its own attach, as the new owner

      attach(PANE, DESKTOP_WINDOW);

      const firstEvents = await ownerEventsAtLeast(first, 3);
      const secondEvents = await ownerEventsAtLeast(second, 2);
      expect(firstEvents[2]).toMatchObject({
        args: [{ paneId: PANE, owner: false }],
      });
      expect(secondEvents[1]).toMatchObject({
        args: [{ paneId: PANE, owner: false }],
      });
    });

    it("hands ownership back to the most recent bridge viewer once the desktop lets go", async () => {
      sessionSize = { cols: 100, rows: 30 };
      const first = await greet(FULL_TOKEN);
      await watch(first);
      await invoke(first, "c1", "pty", "create", [PANE, null, 100, 30]);
      await ownerEventsAtLeast(first, 1); // its own attach

      attach(PANE, DESKTOP_WINDOW);
      await ownerEventsAtLeast(first, 2); // desktop took ownership

      release(PANE, DESKTOP_WINDOW);
      const events = await ownerEventsAtLeast(first, 3);
      expect(events[2]).toMatchObject({
        args: [{ paneId: PANE, owner: true }],
      });
    });

    it("drops a non-owner bridge viewer's resize instead of forwarding it", async () => {
      sessionSize = { cols: 100, rows: 30 };
      const first = await greet(FULL_TOKEN);
      await invoke(first, "c1", "pty", "create", [PANE, null, 100, 30]);
      const second = await greet(FULL_TOKEN);
      await invoke(second, "c2", "pty", "create", [PANE, null, 100, 30]);
      // `second` is now the owner (most recently attached); `first` is not.
      resized.length = 0;

      const result = await invoke(first, "r1", "pty", "resize", [
        PANE,
        90,
        20,
      ]);
      expect(result).toMatchObject({ ok: true });
      expect(resized).toEqual([]);

      await invoke(second, "r2", "pty", "resize", [PANE, 90, 20]);
      expect(resized).toEqual([[PANE, 90, 20]]);
    });
  });

  describe("listenerCount", () => {
    /**
     * A browser on the bridge is a watcher. Counting only the SSE hub showed a
     * paired laptop with the whole app open as "0 listening" in the settings
     * page, which is the one number that page exists to be right about.
     */
    it("counts a bridge socket", async () => {
      expect(server.listenerCount).toBe(0);
      const client = await greet(FULL_TOKEN);
      await client.next((f) => f.type === "hello");
      expect(server.listenerCount).toBe(1);

      client.socket.close();
      await client.closed;
      await vi.waitFor(() => expect(server.listenerCount).toBe(0));
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
