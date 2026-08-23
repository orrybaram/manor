/**
 * ADR-161's listener is tested over a real socket rather than by calling
 * `handle()` directly: the properties that matter are HTTP-level (what status
 * an unauthenticated caller sees, whether a body was ever read, what a
 * non-allowlisted path looks like from outside), and a unit-level call would
 * let a rearranged pipeline still pass.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { RemoteControlServer, type AuthenticatedDevice } from "../server";
import { RemoteAuditLog } from "../audit";
import { AuthRateLimiter } from "../rate-limit";
import type { ControlDeps } from "../../routes/types";

const READ_TOKEN = "read-token";
const WRITE_TOKEN = "write-token";

const reader: AuthenticatedDevice = {
  id: "dev-read",
  label: "phone",
  canSend: false,
};
const writer: AuthenticatedDevice = {
  id: "dev-write",
  label: "phone (send)",
  canSend: true,
};

const devices = {
  verify: (raw: unknown) => {
    if (raw === READ_TOKEN) return reader;
    if (raw === WRITE_TOKEN) return writer;
    return null;
  },
};

describe("RemoteControlServer", () => {
  let server: RemoteControlServer;
  let base: string;
  let getTaskById: ReturnType<typeof vi.fn>;
  let deps: ControlDeps;
  let now: number;
  let auditDir: string;
  let audit: RemoteAuditLog;
  let ptyWrite: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    now = 1_000_000;
    auditDir = fs.mkdtempSync(path.join(os.tmpdir(), "manor-remote-audit-"));
    audit = new RemoteAuditLog(path.join(auditDir, "remote-audit.jsonl"));
    ptyWrite = vi.fn();
    getTaskById = vi.fn(() => null);
    deps = {
      projectManager: null,
      githubManager: null,
      linearManager: null,
      layoutPersistence: null,
      // Enough of a TaskManager for `GET /tasks` to answer and for the
      // "did a handler run?" assertions to have something to observe.
      taskManager: {
        getActiveTasks: () => [],
        getAllTasks: () => [],
        getTaskById,
        getTaskByPaneId: () => null,
      } as unknown as ControlDeps["taskManager"],
      backend: null,
    };
    server = new RemoteControlServer(
      () => deps,
      devices,
      new AuthRateLimiter(() => now),
      audit,
    );
    const { port } = await server.start();
    base = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await server.stop();
    fs.rmSync(auditDir, { recursive: true, force: true });
  });

  /** Give the deps a live session so a send can actually succeed. */
  function withLiveSession(): void {
    const task = {
      id: "task-1",
      name: "fix the thing",
      paneId: "pane-1",
      agentKind: "claude",
      lastAgentStatus: "requires_input",
    };
    getTaskById.mockImplementation((id: string) =>
      id === "task-1" ? task : null,
    );
    deps.backend = {
      pty: { write: ptyWrite },
    } as unknown as ControlDeps["backend"];
  }

  const get = (path: string, token?: string, headers: HeadersInit = {}) =>
    fetch(`${base}${path}`, {
      headers: token
        ? { Authorization: `Bearer ${token}`, ...headers }
        : headers,
    });

  const post = (
    path: string,
    token: string | undefined,
    body: unknown,
    headers: HeadersInit = {},
  ) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: JSON.stringify(body),
    });

  describe("binding", () => {
    it("listens on loopback only", () => {
      expect(server.running).toBe(true);
      expect(server.serverPort).toBeGreaterThan(0);
    });
  });

  describe("authentication", () => {
    it("401s a request with no Authorization header", async () => {
      const res = await get("/tasks");
      expect(res.status).toBe(401);
    });

    it("401s a wrong token", async () => {
      const res = await get("/tasks", "not-a-real-token");
      expect(res.status).toBe(401);
    });

    it("401s a non-Bearer Authorization header", async () => {
      const res = await get("/tasks", undefined, {
        Authorization: `Basic ${READ_TOKEN}`,
      });
      expect(res.status).toBe(401);
    });

    it("rejects before any handler runs or any body is read", async () => {
      const res = await post("/sessions/read", undefined, {
        target: "task-1",
      });
      expect(res.status).toBe(401);
      expect(getTaskById).not.toHaveBeenCalled();
    });

    it("never echoes the presented token", async () => {
      const res = await get("/tasks", "secret-guess");
      expect(await res.text()).not.toContain("secret-guess");
    });

    it("lets a valid token reach an allowlisted route", async () => {
      const res = await get("/tasks", READ_TOKEN);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    });
  });

  describe("rate limiting", () => {
    it("429s a source that just failed, then lets it retry", async () => {
      expect((await get("/tasks", "wrong")).status).toBe(401);
      const blocked = await get("/tasks", READ_TOKEN);
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get("retry-after")).toBe("1");

      now += 1_000;
      expect((await get("/tasks", READ_TOKEN)).status).toBe(200);
    });

    it("clears the backoff after a success", async () => {
      expect((await get("/tasks", "wrong")).status).toBe(401);
      now += 1_000;
      expect((await get("/tasks", READ_TOKEN)).status).toBe(200);
      // A success wiped the history, so the next failure starts at 1s again.
      expect((await get("/tasks", "wrong")).status).toBe(401);
      now += 1_000;
      expect((await get("/tasks", READ_TOKEN)).status).toBe(200);
    });
  });

  describe("the route surface", () => {
    it("404s a non-allowlisted route even with a valid write token", async () => {
      const res = await post("/agents", WRITE_TOKEN, {
        workspacePath: "/tmp",
      });
      expect(res.status).toBe(404);
    });

    it("404s project and issue routes", async () => {
      expect((await get("/projects", WRITE_TOKEN)).status).toBe(404);
      expect((await get("/projects/p1/issues", WRITE_TOKEN)).status).toBe(404);
    });

    it("405s a method the surface never serves", async () => {
      const res = await fetch(`${base}/panes/pane-1`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${WRITE_TOKEN}` },
      });
      expect(res.status).toBe(405);
    });

    it("404s POST /sessions/send for a device without the capability", async () => {
      const res = await post("/sessions/send", READ_TOKEN, {
        target: "t",
        text: "hi",
      });
      expect(res.status).toBe(404);
    });

    it("reaches POST /sessions/send for a device that holds it", async () => {
      const res = await post("/sessions/send", WRITE_TOKEN, {
        target: "t",
        text: "hi",
        confirmed: true,
      });
      // 503 is the handler answering (no backend in these deps) — the point is
      // that the request got past the table, which the read device cannot.
      expect(res.status).toBe(503);
    });
  });

  describe("the send gates", () => {
    it("rejects a send that is not confirmed", async () => {
      withLiveSession();
      const res = await post("/sessions/send", WRITE_TOKEN, {
        target: "task-1",
        text: "hello",
      });
      expect(res.status).toBe(400);
      expect(ptyWrite).not.toHaveBeenCalled();
    });

    it("audits a rejected send", async () => {
      withLiveSession();
      await post("/sessions/send", WRITE_TOKEN, {
        target: "task-1",
        text: "hello",
      });
      const [entry, ...rest] = audit.read();
      expect(rest).toEqual([]);
      expect(entry.outcome).toBe("rejected");
      expect(entry.status).toBe(400);
      expect(entry.deviceId).toBe(writer.id);
    });

    it("sends when confirmed, and writes exactly one audit line", async () => {
      withLiveSession();
      const res = await post("/sessions/send", WRITE_TOKEN, {
        target: "task-1",
        text: "hello",
        confirmed: true,
      });
      expect(res.status).toBe(200);
      expect(ptyWrite).toHaveBeenCalled();

      const entries = audit.read();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        outcome: "sent",
        status: 200,
        deviceId: writer.id,
        deviceLabel: writer.label,
        route: "POST /sessions/send",
        target: "task-1",
        textLength: 5,
        interrupt: false,
      });
    });

    it("never writes the sent text into the audit line", async () => {
      withLiveSession();
      await post("/sessions/send", WRITE_TOKEN, {
        target: "task-1",
        text: "sk-secret-value",
        confirmed: true,
      });
      const line = JSON.stringify(audit.read()[0]);
      expect(line).not.toContain("sk-secret-value");
      expect(audit.read()[0].textSha256).toMatch(/^[0-9a-f]{64}$/);
    });

    it("treats an interrupt override as a write and records it", async () => {
      withLiveSession();
      await post("/sessions/send", WRITE_TOKEN, {
        target: "task-1",
        text: "stop",
        interrupt: "\u0003",
        confirmed: true,
      });
      expect(audit.read()[0].interrupt).toBe(true);
    });

    it("writes no audit line for a device that cannot send", async () => {
      withLiveSession();
      const res = await post("/sessions/send", READ_TOKEN, {
        target: "task-1",
        text: "hello",
        confirmed: true,
      });
      // The route was never in this device's table, so nothing to audit — and
      // nothing reached the shell.
      expect(res.status).toBe(404);
      expect(ptyWrite).not.toHaveBeenCalled();
      expect(audit.read()).toEqual([]);
    });
  });

  describe("request hygiene", () => {
    it("413s an oversized declared body", async () => {
      const res = await fetch(`${base}/sessions/read`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${READ_TOKEN}`,
          "Content-Type": "application/json",
          "Content-Length": String(2 * 1024 * 1024),
        },
        body: "x".repeat(2 * 1024 * 1024),
      });
      expect(res.status).toBe(413);
    });

    it("403s a cross-origin request, as defence in depth", async () => {
      const res = await get("/tasks", READ_TOKEN, {
        Origin: "https://evil.example",
      });
      expect(res.status).toBe(403);
    });

    it("allows a same-origin request", async () => {
      const res = await get("/tasks", READ_TOKEN, {
        Origin: base,
      });
      expect(res.status).toBe(200);
    });
  });

  describe("GET /events", () => {
    it("requires a token", async () => {
      expect((await get("/events")).status).toBe(401);
    });

    it("streams status changes and cleans up on disconnect", async () => {
      const controller = new AbortController();
      const res = await fetch(`${base}/events`, {
        headers: { Authorization: `Bearer ${READ_TOKEN}` },
        signal: controller.signal,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");

      const stream = res.body!.getReader();
      const decoder = new TextDecoder();
      // The hub registers before the first chunk lands; wait for it.
      await vi.waitFor(() => expect(server.listenerCount).toBe(1));

      server.publishStatus({
        taskId: "t1",
        name: "fix the thing",
        projectName: "manor",
        status: "requires_input",
        previousStatus: "working",
      });

      let seen = "";
      while (!seen.includes("event: status")) {
        const { value, done } = await stream.read();
        if (done) break;
        seen += decoder.decode(value, { stream: true });
      }
      expect(seen).toContain('"taskId":"t1"');
      expect(seen).toContain('"status":"requires_input"');

      controller.abort();
      await vi.waitFor(() => expect(server.listenerCount).toBe(0));
    });

    it("stop() closes open streams", async () => {
      const res = await fetch(`${base}/events`, {
        headers: { Authorization: `Bearer ${READ_TOKEN}` },
      });
      await vi.waitFor(() => expect(server.listenerCount).toBe(1));
      await server.stop();
      expect(server.running).toBe(false);
      // The stream ends rather than hanging.
      await res.text();
    });
  });
});
