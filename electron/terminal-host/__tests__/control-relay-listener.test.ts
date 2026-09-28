import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CONTROL_TOKEN_HEADER,
  MAX_CONTROL_BODY_BYTES,
  ControlRelayListener,
  ControlRelayStreams,
  type ControlRelay,
} from "../control-relay-listener";
import type { StreamEvent } from "../types";

describe("ControlRelayListener", () => {
  let listener: ControlRelayListener | null = null;
  let dir: string | null = null;

  afterEach(() => {
    listener?.stop();
    listener = null;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  async function start(relay: ControlRelay) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "control-relay-"));
    const portFile = path.join(dir, "remote", "control-port");
    const env: NodeJS.ProcessEnv = {};
    listener = new ControlRelayListener({ relay, portFile, env });
    const port = await listener.start();
    const [, token] = fs.readFileSync(portFile, "utf-8").split("\n");
    const url = (p: string) => `http://127.0.0.1:${port}${p}`;
    return { port, portFile, env, token: token!, url };
  }

  it("publishes `<port>\\n<token>\\n` at 0600 and sets MANOR_CONTROL_PORT_FILE", async () => {
    const { port, portFile, env, token } = await start(() => null);
    expect(fs.readFileSync(portFile, "utf-8")).toBe(`${port}\n${token}\n`);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.statSync(portFile).mode & 0o777).toBe(0o600);
    expect(env.MANOR_CONTROL_PORT_FILE).toBe(portFile);
  });

  it("refuses requests without the token, or with the wrong one", async () => {
    const relay = vi.fn<ControlRelay>(() => null);
    const { url } = await start(relay);
    expect((await fetch(url("/projects"))).status).toBe(403);
    const wrong = await fetch(url("/projects"), {
      headers: { [CONTROL_TOKEN_HEADER]: "0".repeat(64) },
    });
    expect(wrong.status).toBe(403);
    expect(relay).not.toHaveBeenCalled();
  });

  it("answers 503 when there is no relay stream", async () => {
    const { url, token } = await start(() => null);
    const res = await fetch(url("/projects"), { headers: { [CONTROL_TOKEN_HEADER]: token } });
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({
      error: "Manor desktop is not connected to this host",
    });
  });

  it("relays method, path with query and parsed body, and passes the answer through", async () => {
    const relay = vi.fn<ControlRelay>(() =>
      Promise.resolve({ status: 201, body: { id: "ws-1" } }),
    );
    const { url, token } = await start(relay);
    const res = await fetch(url("/projects/p1/workspaces?x=1"), {
      method: "POST",
      headers: { [CONTROL_TOKEN_HEADER]: token, "content-type": "application/json" },
      body: JSON.stringify({ name: "feat" }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: "ws-1" });
    expect(relay).toHaveBeenCalledWith({
      method: "POST",
      path: "/projects/p1/workspaces?x=1",
      body: { name: "feat" },
    });
  });

  it("relays an empty body as undefined", async () => {
    const relay = vi.fn<ControlRelay>(() => Promise.resolve({ status: 200, body: [] }));
    const { url, token } = await start(relay);
    await fetch(url("/agents"), { headers: { [CONTROL_TOKEN_HEADER]: token } });
    expect(relay).toHaveBeenCalledWith({ method: "GET", path: "/agents", body: undefined });
  });

  it("answers 400 for a body that isn't JSON", async () => {
    const relay = vi.fn<ControlRelay>(() => null);
    const { url, token } = await start(relay);
    const res = await fetch(url("/folders"), {
      method: "POST",
      headers: { [CONTROL_TOKEN_HEADER]: token },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect(relay).not.toHaveBeenCalled();
  });

  it("answers 413 for a body over the limit", async () => {
    const relay = vi.fn<ControlRelay>(() => null);
    const { url, token } = await start(relay);
    const res = await fetch(url("/folders"), {
      method: "POST",
      headers: { [CONTROL_TOKEN_HEADER]: token },
      body: "x".repeat(MAX_CONTROL_BODY_BYTES + 1),
    });
    expect(res.status).toBe(413);
    expect(relay).not.toHaveBeenCalled();
  });

  it("answers 502 when main sends an invalid status", async () => {
    const { url, token } = await start(() => Promise.resolve({ status: 42, body: null }));
    const res = await fetch(url("/agents"), { headers: { [CONTROL_TOKEN_HEADER]: token } });
    expect(res.status).toBe(502);
  });

  it("removes its port file on stop", async () => {
    const { portFile } = await start(() => null);
    listener!.stop();
    listener = null;
    expect(fs.existsSync(portFile)).toBe(false);
  });
});

describe("ControlRelayStreams", () => {
  interface FakeStream {
    name: string;
    sent: StreamEvent[];
  }
  const stream = (name: string): FakeStream => ({ name, sent: [] });
  const streams = (timeoutMs?: number) =>
    new ControlRelayStreams<FakeStream>({
      send: (s, event) => s.sent.push(event),
      timeoutMs,
    });
  const req = { method: "GET", path: "/projects?all=1", body: undefined };
  const lastRequest = (s: FakeStream) => {
    const event = s.sent[s.sent.length - 1];
    if (event?.type !== "controlRequest") throw new Error("no controlRequest sent");
    return event;
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns null until a stream enables the relay", () => {
    expect(streams().relay(req)).toBeNull();
  });

  it("sends a controlRequest to the enabled stream and resolves with its response", async () => {
    const relay = streams();
    const a = stream("a");
    relay.enable(a);
    const pending = relay.relay(req)!;
    const event = lastRequest(a);
    expect(event).toMatchObject({ type: "controlRequest", method: "GET", path: "/projects?all=1" });
    relay.respond(a, event.id, 200, { ok: true });
    await expect(pending).resolves.toEqual({ status: 200, body: { ok: true } });
  });

  it("relays to the most recently enabled stream only", () => {
    const relay = streams();
    const a = stream("a");
    const b = stream("b");
    relay.enable(a);
    relay.enable(b);
    void relay.relay(req);
    expect(a.sent).toHaveLength(0);
    expect(b.sent).toHaveLength(1);
  });

  it("ignores unknown ids and answers from another stream", async () => {
    const relay = streams();
    const a = stream("a");
    const b = stream("b");
    relay.enable(a);
    const pending = relay.relay(req)!;
    const { id } = lastRequest(a);
    relay.respond(a, "nope", 500, null);
    relay.respond(b, id, 500, null);
    relay.respond(a, id, 204, null);
    await expect(pending).resolves.toEqual({ status: 204, body: null });
  });

  it("times a request out with 504", async () => {
    vi.useFakeTimers();
    const relay = streams(1000);
    const a = stream("a");
    relay.enable(a);
    const pending = relay.relay(req)!;
    const { id } = lastRequest(a);
    vi.advanceTimersByTime(1000);
    await expect(pending).resolves.toEqual({
      status: 504,
      body: { error: "Manor desktop did not answer in time" },
    });
    // A late answer is dropped.
    relay.respond(a, id, 200, null);
  });

  it("resolves a closed stream's pending requests with 503 and stops relaying to it", async () => {
    const relay = streams();
    const a = stream("a");
    relay.enable(a);
    const pending = relay.relay(req)!;
    relay.closed(a);
    await expect(pending).resolves.toEqual({
      status: 503,
      body: { error: "Manor desktop is not connected to this host" },
    });
    expect(relay.relay(req)).toBeNull();
  });

  it("keeps the relay stream when another stream closes", async () => {
    const relay = streams();
    const a = stream("a");
    const b = stream("b");
    relay.enable(a);
    relay.enable(b);
    relay.closed(a);
    const pending = relay.relay(req)!;
    relay.respond(b, lastRequest(b).id, 200, "ok");
    await expect(pending).resolves.toEqual({ status: 200, body: "ok" });
  });
});
