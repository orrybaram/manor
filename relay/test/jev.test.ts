import { SELF, env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  base64urlEncode,
  signJevRequest,
  type RelayIdentity,
} from "../../src/lib/relay-crypto";
import { INSTRUCTIONS, JEV_MODEL, handleJevFolder } from "../src/jev";
import { freshIp, newIdentity } from "./helpers";

const ORIGIN = "https://relay.test";
/** Matches `JEV_UPSTREAM_URL` / `TYPESAFE_API_KEY` in vitest.config.ts. */
const UPSTREAM = "https://typesafe.test/v1/systemone";
const TEST_KEY = "test-typesafe-key";

const STATE = { workspaceName: "fix login bug", branchName: "fix/login" };
const OPTIONS = {
  f1: 'Folder "Auth". Contains workspaces: oauth, sessions',
  f2: 'Folder "Docs".',
  __none__: "Fits none of these folders",
};

interface Payload {
  state: Record<string, unknown>;
  options: Record<string, unknown>;
}

function signedBody(
  identity: RelayIdentity,
  payload: Payload = { state: STATE, options: OPTIONS },
  ts = Date.now(),
): Record<string, unknown> {
  return {
    v: 1,
    pub: base64urlEncode(identity.ed25519.pub),
    ts,
    sig: base64urlEncode(signJevRequest(identity.ed25519.priv, ts, payload)),
    ...payload,
  };
}

function jevRequest(body: unknown): Request {
  return new Request(`${ORIGIN}/jev/folder`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": freshIp(),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function post(body: unknown): Promise<Response> {
  return SELF.fetch(jevRequest(body));
}

let upstreamCalls: { url: string; init: RequestInit }[] = [];
let upstreamReply: () => Response;

beforeEach(() => {
  upstreamCalls = [];
  upstreamReply = () =>
    Response.json({ answers: { pick: { choice: "f1", confidence: 0.83 } } });
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== UPSTREAM) return realFetch(input, init);
    upstreamCalls.push({ url, init: init ?? {} });
    return upstreamReply();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /jev/folder", () => {
  it("asks TypeSafe the fixed question and returns only choice and confidence", async () => {
    const { identity } = newIdentity();
    const res = await post(signedBody(identity));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ choice: "f1", confidence: 0.83 });

    expect(upstreamCalls).toHaveLength(1);
    const { init } = upstreamCalls[0];
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${TEST_KEY}`);
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({
      model: "jev-1.13.0",
      state: STATE,
      questions: {
        pick: {
          type: "choice",
          instructions:
            "Which sidebar folder should this new workspace be filed under? Folders group related workspaces; judge by what the folder's existing workspaces are about.",
          criteria: OPTIONS,
        },
      },
    });
    expect(JEV_MODEL).toBe("jev-1.13.0");
    expect(INSTRUCTIONS).toMatch(/^Which sidebar folder/);
  });

  it("retries a busy TypeSafe once", async () => {
    const { identity } = newIdentity();
    let n = 0;
    upstreamReply = () =>
      n++ === 0
        ? new Response("busy", { status: 529 })
        : Response.json({ answers: { pick: { choice: "f2", confidence: 1 } } });
    const res = await post(signedBody(identity));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ choice: "f2", confidence: 1 });
    expect(upstreamCalls).toHaveLength(2);
  });

  it("405s anything but POST", async () => {
    const res = await SELF.fetch(`${ORIGIN}/jev/folder`);
    expect(res.status).toBe(405);
    await res.arrayBuffer();
  });

  it("413s a body over 16 KiB", async () => {
    const res = await post("x".repeat(16 * 1024 + 1));
    expect(res.status).toBe(413);
    await res.arrayBuffer();
  });

  it("401s a bad signature", async () => {
    const { identity } = newIdentity();
    const body = signedBody(identity);
    // Signed over different state than it carries.
    body.state = { workspaceName: "something else" };
    const res = await post(body);
    expect(res.status).toBe(401);
    await res.arrayBuffer();

    const other = newIdentity().identity;
    const swapped = signedBody(identity);
    swapped.pub = base64urlEncode(other.ed25519.pub);
    const res2 = await post(swapped);
    expect(res2.status).toBe(401);
    await res2.arrayBuffer();
    expect(upstreamCalls).toHaveLength(0);
  });

  it("401s a stale or future ts", async () => {
    const { identity } = newIdentity();
    for (const skew of [-6 * 60_000, 6 * 60_000]) {
      const body = signedBody(identity, undefined, Date.now() + skew);
      const res = await post(body);
      expect(res.status, String(skew)).toBe(401);
      await res.arrayBuffer();
    }
    expect(upstreamCalls).toHaveLength(0);
  });

  it("400s malformed requests and invalid options or state", async () => {
    const { identity } = newIdentity();
    const tooMany: Record<string, string> = {};
    for (let i = 0; i < 65; i++) tooMany[`f${i}`] = "a folder";
    const cases: [string, unknown][] = [
      ["not JSON", "{"],
      ["array", []],
      ["wrong version", { ...signedBody(identity), v: 2 }],
      ["short pub", { ...signedBody(identity), pub: "AAAA" }],
      ["float ts", { ...signedBody(identity), ts: 1.5 }],
      ["short sig", { ...signedBody(identity), sig: "AAAA" }],
    ];
    const badPayloads: [string, Payload][] = [
      ["one option", { state: STATE, options: { f1: "a" } }],
      ["65 options", { state: STATE, options: tooMany }],
      [
        "long key",
        { state: STATE, options: { ["k".repeat(65)]: "a", f2: "b" } },
      ],
      ["bad key", { state: STATE, options: { "a.b": "a", f2: "b" } }],
      [
        "long desc",
        { state: STATE, options: { f1: "x".repeat(401), f2: "b" } },
      ],
      ["empty desc", { state: STATE, options: { f1: "", f2: "b" } }],
      ["number desc", { state: STATE, options: { f1: 1, f2: "b" } }],
      ["options array", { state: STATE, options: ["a", "b"] as never }],
      ["no workspaceName", { state: { branchName: "x" }, options: OPTIONS }],
      ["unknown state", { state: { ...STATE, extra: "x" }, options: OPTIONS }],
      [
        "long prompt",
        {
          state: { ...STATE, agentPrompt: "p".repeat(2001) },
          options: OPTIONS,
        },
      ],
      [
        "long name",
        { state: { workspaceName: "n".repeat(201) }, options: OPTIONS },
      ],
    ];
    for (const [what, payload] of badPayloads) {
      cases.push([what, signedBody(identity, payload)]);
    }
    for (const [what, body] of cases) {
      const res = await post(body);
      expect(res.status, what).toBe(400);
      await res.arrayBuffer();
    }
    expect(upstreamCalls).toHaveLength(0);
  });

  it("502s a choice that is not one of the options", async () => {
    const { identity } = newIdentity();
    upstreamReply = () =>
      Response.json({ answers: { pick: { choice: "nope", confidence: 0.9 } } });
    const res = await post(signedBody(identity));
    expect(res.status).toBe(502);
    await res.arrayBuffer();
  });

  it("502s an upstream error", async () => {
    const { identity } = newIdentity();
    upstreamReply = () => new Response("nope", { status: 500 });
    const res = await post(signedBody(identity));
    expect(res.status).toBe(502);
    await res.arrayBuffer();
    expect(upstreamCalls).toHaveLength(1);
  });

  it("503s without the TypeSafe secret", async () => {
    const { identity } = newIdentity();
    const res = await handleJevFolder(jevRequest(signedBody(identity)), {
      ...env,
      TYPESAFE_API_KEY: undefined,
    });
    expect(res.status).toBe(503);
    expect(upstreamCalls).toHaveLength(0);
  });

  it("503s once the daily budget is spent", async () => {
    const stub = env.JEV_BUDGET.get(env.JEV_BUDGET.idFromName("global"));
    await runInDurableObject(stub, (_obj, state) => state.storage.deleteAll());
    const capped = { ...env, JEV_DAILY_CALLS: "2" };
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      const { identity } = newIdentity();
      const res = await handleJevFolder(
        jevRequest(signedBody(identity)),
        capped,
      );
      statuses.push(res.status);
      if (i === 2)
        expect(await res.json()).toEqual({ error: "daily budget spent" });
      else await res.arrayBuffer();
    }
    expect(statuses).toEqual([200, 200, 503]);
    expect(upstreamCalls).toHaveLength(2);
  });

  it("rate-limits per identity", async () => {
    const { identity } = newIdentity();
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) {
      const res = await post(signedBody(identity));
      statuses.push(res.status);
      await res.arrayBuffer();
    }
    expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect(statuses).toContain(429);
  });

  describe("observability", () => {
    async function run(body: unknown, extraEnv: Partial<typeof env> = {}) {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const points: unknown[] = [];
      const e = {
        ...env,
        ...extraEnv,
        JEV_EVENTS: { writeDataPoint: (p: unknown) => points.push(p) },
      };
      const res = await handleJevFolder(jevRequest(body), e);
      await res.arrayBuffer();
      const lines = log.mock.calls.map((c) => String(c[0]));
      return { res, lines, points };
    }

    function expectContentFree(line: string) {
      for (const secret of [
        STATE.workspaceName,
        STATE.branchName,
        OPTIONS.f1,
        OPTIONS.f2,
        "Auth",
      ]) {
        expect(line).not.toContain(secret);
      }
    }

    it("logs one content-free line and a data point when served", async () => {
      const { identity } = newIdentity();
      const { lines, points } = await run(signedBody(identity));
      expect(lines).toHaveLength(1);
      expectContentFree(lines[0]);
      const entry = JSON.parse(lines[0]);
      expect(entry).toMatchObject({
        event: "jev",
        outcome: "served",
        status: 200,
        options: 3,
        band: ">=0.8",
      });
      expect(points).toHaveLength(1);
      expect(points[0]).toMatchObject({
        indexes: ["served"],
        blobs: ["served", ">=0.8"],
      });
      expect((points[0] as { doubles: number[] }).doubles.slice(0, 4)).toEqual([
        200,
        entry.ms,
        3,
        0.83,
      ]);
    });

    it("logs bad_signature", async () => {
      const { identity } = newIdentity();
      const body = signedBody(identity);
      body.state = { workspaceName: "something else" };
      const { lines, points } = await run(body);
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toMatchObject({
        outcome: "bad_signature",
        status: 401,
      });
      expect(JSON.parse(lines[0]).band).toBeUndefined();
      expectContentFree(lines[0]);
      expect(points[0]).toMatchObject({ indexes: ["bad_signature"] });
    });

    it("logs over_budget", async () => {
      const stub = env.JEV_BUDGET.get(env.JEV_BUDGET.idFromName("global"));
      await runInDurableObject(stub, (_o, state) => state.storage.deleteAll());
      const { identity } = newIdentity();
      const { lines } = await run(signedBody(identity), {
        JEV_DAILY_CALLS: "0",
      });
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toMatchObject({
        outcome: "over_budget",
        status: 503,
      });
      expectContentFree(lines[0]);
    });

    it("logs upstream_error with the upstream status", async () => {
      upstreamReply = () => new Response("nope", { status: 500 });
      const { identity } = newIdentity();
      const { lines, points } = await run(signedBody(identity));
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toMatchObject({
        outcome: "upstream_error",
        status: 502,
        upstream_status: 500,
      });
      expectContentFree(lines[0]);
      expect(points[0]).toMatchObject({ indexes: ["upstream_error"] });
    });

    it("survives a throwing data-point writer", async () => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      const res = await handleJevFolder(jevRequest("{"), {
        ...env,
        JEV_EVENTS: {
          writeDataPoint: () => {
            throw new Error("boom");
          },
        },
      });
      expect(res.status).toBe(400);
      await res.arrayBuffer();
    });
  });
});
