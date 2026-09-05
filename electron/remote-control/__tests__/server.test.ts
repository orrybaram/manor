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
  let getAgentById: ReturnType<typeof vi.fn>;
  let deps: ControlDeps;
  let now: number;
  let auditDir: string;
  let audit: RemoteAuditLog;
  let clientDir: string;
  let subscribe: ReturnType<typeof vi.fn>;
  let ptyWrite: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    now = 1_000_000;
    auditDir = fs.mkdtempSync(path.join(os.tmpdir(), "manor-remote-audit-"));
    audit = new RemoteAuditLog(path.join(auditDir, "remote-audit.jsonl"));
    clientDir = fs.mkdtempSync(path.join(os.tmpdir(), "manor-remote-client-"));
    fs.writeFileSync(
      path.join(clientDir, "index.html"),
      "<!doctype html><title>Manor</title>",
    );
    fs.mkdirSync(path.join(clientDir, "assets"));
    fs.writeFileSync(path.join(clientDir, "assets", "app.js"), "export {};");
    ptyWrite = vi.fn();
    subscribe = vi.fn(() => true);
    getAgentById = vi.fn(() => null);
    deps = {
      projectManager: null,
      githubManager: null,
      linearManager: null,
      layoutPersistence: null,
      // Enough of an AgentManager for `GET /agents` to answer and for the
      // "did a handler run?" assertions to have something to observe.
      agentManager: {
        getActiveAgents: () => [],
        getAllAgents: () => [],
        getAgentById,
        getAgentByPaneId: () => null,
      } as unknown as ControlDeps["agentManager"],
      backend: null,
    };
    server = new RemoteControlServer(() => deps, devices, {
      limiter: new AuthRateLimiter(() => now),
      audit,
      clientDir,
      push: {
        publicKey: () => "vapid-public-key",
        subscribe,
      } as unknown as import("../push").PushManager,
    });
    const { port } = await server.start();
    base = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await server.stop();
    fs.rmSync(auditDir, { recursive: true, force: true });
    fs.rmSync(clientDir, { recursive: true, force: true });
  });

  /** Give the deps a live session so a send can actually succeed. */
  function withLiveSession(): void {
    const agent = {
      id: "agent-1",
      name: "fix the thing",
      paneId: "pane-1",
      agentKind: "claude",
      lastAgentStatus: "requires_input",
    };
    getAgentById.mockImplementation((id: string) =>
      id === "agent-1" ? agent : null,
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
      const res = await get("/agents");
      expect(res.status).toBe(401);
    });

    it("401s a wrong token", async () => {
      const res = await get("/agents", "not-a-real-token");
      expect(res.status).toBe(401);
    });

    it("401s a non-Bearer Authorization header", async () => {
      const res = await get("/agents", undefined, {
        Authorization: `Basic ${READ_TOKEN}`,
      });
      expect(res.status).toBe(401);
    });

    it("rejects before any handler runs or any body is read", async () => {
      const res = await post("/sessions/read", undefined, {
        target: "agent-1",
      });
      expect(res.status).toBe(401);
      expect(getAgentById).not.toHaveBeenCalled();
    });

    it("never echoes the presented token", async () => {
      const res = await get("/agents", "secret-guess");
      expect(await res.text()).not.toContain("secret-guess");
    });

    it("lets a valid token reach an allowlisted route", async () => {
      const res = await get("/agents", READ_TOKEN);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    });
  });

  describe("rate limiting", () => {
    it("429s a source that just failed, then lets it retry", async () => {
      expect((await get("/agents", "wrong")).status).toBe(401);
      const blocked = await get("/agents", "wrong-again");
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get("retry-after")).toBe("1");

      now += 1_000;
      expect((await get("/agents", "wrong-again")).status).toBe(401);
    });

    // The reason verification runs before the backoff check. This listener is
    // loopback-bound, so behind a tunnel every remote caller shares one source
    // address: a stranger guessing tokens against a discovered hostname and the
    // owner's phone land in the same bucket. If the backoff could reject an
    // authenticated request, the guesser would be locking the owner out of
    // their own machine — from away from it, which is the one situation this
    // feature exists for.
    it("serves a valid token while another caller is being backed off", async () => {
      for (let i = 0; i < 5; i++) {
        await get("/agents", `guess-${i}`);
      }
      // Same source, deep into exponential backoff, and still served.
      expect((await get("/agents", READ_TOKEN)).status).toBe(200);
    });

    // The bug this covers: a phone loads the client, the browser asks for
    // `/favicon.ico` with no `Authorization` header, and the app's own first
    // call — with a perfectly good token — came back 429.
    it("does not back off a request that presented no token at all", async () => {
      expect((await get("/favicon.ico")).status).toBe(401);
      expect((await get("/agents")).status).toBe(401);
      expect((await get("/agents", READ_TOKEN)).status).toBe(200);
    });

    it("clears the backoff after a success", async () => {
      expect((await get("/agents", "wrong")).status).toBe(401);
      expect((await get("/agents", READ_TOKEN)).status).toBe(200);
      // The success wiped the history, so the next failure starts at 1s again
      // rather than resuming the doubling.
      expect((await get("/agents", "wrong")).status).toBe(401);
      expect((await get("/agents", "wrong")).headers.get("retry-after")).toBe(
        "1",
      );
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
        target: "agent-1",
        text: "hello",
      });
      expect(res.status).toBe(400);
      expect(ptyWrite).not.toHaveBeenCalled();
    });

    it("audits a rejected send", async () => {
      withLiveSession();
      await post("/sessions/send", WRITE_TOKEN, {
        target: "agent-1",
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
        target: "agent-1",
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
        target: "agent-1",
        textLength: 5,
        interrupt: false,
      });
    });

    it("never writes the sent text into the audit line", async () => {
      withLiveSession();
      await post("/sessions/send", WRITE_TOKEN, {
        target: "agent-1",
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
        target: "agent-1",
        text: "stop",
        interrupt: "\u0003",
        confirmed: true,
      });
      expect(audit.read()[0].interrupt).toBe(true);
    });

    it("stops a session without saying anything to it", async () => {
      withLiveSession();
      const res = await post("/sessions/interrupt", WRITE_TOKEN, {
        target: "agent-1",
        confirmed: true,
      });
      expect(res.status).toBe(200);
      // Exactly one write: the interrupt sequence, and no prompt after it.
      expect(ptyWrite).toHaveBeenCalledTimes(1);

      const entries = audit.read();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        outcome: "sent",
        status: 200,
        route: "POST /sessions/interrupt",
        target: "agent-1",
        interrupt: true,
        textLength: null,
        textSha256: null,
      });
    });

    it("rejects an interrupt that is not confirmed", async () => {
      withLiveSession();
      const res = await post("/sessions/interrupt", WRITE_TOKEN, {
        target: "agent-1",
      });
      expect(res.status).toBe(400);
      expect(ptyWrite).not.toHaveBeenCalled();
      // Still audited: an unconfirmed interrupt is someone trying to stop an
      // agent without going through the UI, which is worth a line.
      expect(audit.read()[0]).toMatchObject({
        outcome: "rejected",
        route: "POST /sessions/interrupt",
        interrupt: true,
      });
    });

    it("keeps interrupt off a read-only device's surface entirely", async () => {
      withLiveSession();
      const res = await post("/sessions/interrupt", READ_TOKEN, {
        target: "agent-1",
        confirmed: true,
      });
      expect(res.status).toBe(404);
      expect(ptyWrite).not.toHaveBeenCalled();
      expect(audit.read()).toEqual([]);
    });

    it("writes no audit line for a device that cannot send", async () => {
      withLiveSession();
      const res = await post("/sessions/send", READ_TOKEN, {
        target: "agent-1",
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
      const res = await get("/agents", READ_TOKEN, {
        Origin: "https://evil.example",
      });
      expect(res.status).toBe(403);
    });

    it("allows a same-origin request", async () => {
      const res = await get("/agents", READ_TOKEN, {
        Origin: base,
      });
      expect(res.status).toBe(200);
    });
  });

  describe("the served client", () => {
    it("serves the shell without a token, because the token is in the fragment", async () => {
      const res = await fetch(`${base}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(await res.text()).toContain("Manor");
    });

    it("serves it under a CSP that forbids reaching anywhere else", async () => {
      const csp = (await fetch(`${base}/`)).headers.get(
        "content-security-policy",
      );
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("connect-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
    });

    it("serves hashed assets", async () => {
      const res = await fetch(`${base}/assets/app.js`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/javascript");
    });

    it("does not serve anything outside the client directory", async () => {
      const secret = path.join(auditDir, "remote-audit.jsonl");
      fs.writeFileSync(secret, "secret-audit-content");
      const res = await fetch(
        `${base}/../${path.basename(auditDir)}/remote-audit.jsonl`,
      );
      expect(res.status).not.toBe(200);
      expect(await res.text()).not.toContain("secret-audit-content");
    });

    it("never serves an API path as a file", async () => {
      // `/agents` is not a file, so it falls through to the authenticated
      // pipeline and 401s rather than leaking anything.
      expect((await fetch(`${base}/agents`)).status).toBe(401);
    });
  });

  describe("GET /me", () => {
    it("requires a token", async () => {
      expect((await get("/me")).status).toBe(401);
    });

    it("returns this device's own record and nothing else", async () => {
      const res = await get("/me", WRITE_TOKEN);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toEqual({
        id: writer.id,
        label: writer.label,
        canSend: true,
        vapidPublicKey: "vapid-public-key",
      });
      expect(JSON.stringify(body)).not.toContain(WRITE_TOKEN);
    });

    it("includes the public application server key", async () => {
      const body = (await (await get("/me", READ_TOKEN)).json()) as {
        vapidPublicKey: string;
      };
      expect(body.vapidPublicKey).toBe("vapid-public-key");
    });

    it("reports a read-only device as unable to send", async () => {
      const body = (await (await get("/me", READ_TOKEN)).json()) as {
        canSend: boolean;
      };
      expect(body.canSend).toBe(false);
    });
  });

  describe("POST /push/subscribe", () => {
    const subscription = {
      endpoint: "https://push.example/abc",
      keys: { p256dh: "p", auth: "a" },
    };

    it("requires a token", async () => {
      const res = await post("/push/subscribe", undefined, subscription);
      expect(res.status).toBe(401);
      expect(subscribe).not.toHaveBeenCalled();
    });

    it("stores a subscription against the calling device", async () => {
      const res = await post("/push/subscribe", READ_TOKEN, subscription);
      expect(res.status).toBe(200);
      expect(subscribe).toHaveBeenCalledWith(reader.id, subscription);
    });

    it("is open to a read-only device — being told is not a write", async () => {
      expect(
        (await post("/push/subscribe", READ_TOKEN, subscription)).status,
      ).toBe(200);
    });

    it("rejects a malformed subscription", async () => {
      expect((await post("/push/subscribe", READ_TOKEN, {})).status).toBe(400);
      expect(
        (
          await post("/push/subscribe", READ_TOKEN, {
            endpoint: "https://push.example/abc",
          })
        ).status,
      ).toBe(400);
      expect(subscribe).not.toHaveBeenCalled();
    });

    it("refuses a non-https endpoint", async () => {
      const res = await post("/push/subscribe", READ_TOKEN, {
        ...subscription,
        endpoint: "http://push.example/abc",
      });
      expect(res.status).toBe(400);
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
        agentId: "t1",
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
      expect(seen).toContain('"agentId":"t1"');
      expect(seen).toContain('"status":"requires_input"');

      controller.abort();
      await vi.waitFor(() => expect(server.listenerCount).toBe(0));
    });

    it("caps how many streams one device may hold open", async () => {
      const open: AbortController[] = [];
      for (let i = 0; i < 6; i++) {
        const controller = new AbortController();
        open.push(controller);
        await fetch(`${base}/events`, {
          headers: { Authorization: `Bearer ${READ_TOKEN}` },
          signal: controller.signal,
        });
      }
      await vi.waitFor(() => expect(server.listenerCount).toBe(4));
      for (const controller of open) controller.abort();
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
