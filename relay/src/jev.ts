/**
 * `POST /jev/folder` (ADR-211 D1–D3): Manor's hosted Jev, for picking the
 * sidebar folder a new workspace belongs in.
 *
 * The worker owns everything that makes this a Jev request (model, question
 * type, instructions); the desktop sends only the data, signed with its relay
 * identity. So the TypeSafe key behind it is useless for anything but this
 * one question. Limits run cheapest first: per IP, then (once the signature
 * holds) per identity, then the global daily budget in `JevBudget`.
 *
 * Unlike the rooms, this route sees cleartext: folder and workspace names and
 * agent prompts. It never logs or stores a request or response body; see
 * `record` for the only fields that are ever logged or recorded.
 */
import {
  JEV_MAX_BODY_BYTES,
  JEV_MAX_OPTION_CHARS,
  JEV_MAX_OPTIONS,
  JEV_MIN_OPTIONS,
  JEV_OPTION_KEY_PATTERN,
  JEV_STATE_MAX_CHARS,
  type JevPayload,
} from "../../src/lib/jev-protocol";
import {
  base64urlDecode,
  isPlainObject,
  roomIdFor,
  verifyJevRequest,
} from "../../src/lib/relay-crypto";
import type { Env } from "./env";

export const JEV_MODEL = "jev-1.13.0";
/** Moved verbatim from `buildFolderQuestion` (ADR-210 D2). */
export const INSTRUCTIONS =
  "Which sidebar folder should this new workspace be filed under? Folders group related workspaces; judge by what the folder's existing workspaces are about.";

const MAX_CLOCK_SKEW_MS = 5 * 60_000;
const DEFAULT_DAILY_CALLS = 5000;
const DEFAULT_UPSTREAM_URL = "https://api.typesafe.ai";
const UPSTREAM_TIMEOUT_MS = 4000;
const RETRY_DELAY_MS = 300;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

const fail = (status: number, error: string) => json(status, { error });

function isString(v: unknown, min: number, max: number): v is string {
  return typeof v === "string" && v.length >= min && v.length <= max;
}

function decodeBytes(v: unknown, length: number): Uint8Array | null {
  if (typeof v !== "string") return null;
  try {
    const bytes = base64urlDecode(v);
    return bytes.length === length ? bytes : null;
  } catch {
    return null;
  }
}

function validOptions(v: unknown): v is JevPayload["options"] {
  if (!isPlainObject(v)) return false;
  const entries = Object.entries(v);
  if (entries.length < JEV_MIN_OPTIONS || entries.length > JEV_MAX_OPTIONS) {
    return false;
  }
  return entries.every(
    ([k, d]) =>
      JEV_OPTION_KEY_PATTERN.test(k) && isString(d, 1, JEV_MAX_OPTION_CHARS),
  );
}

/** Only known fields, each within its limit; `workspaceName` must be non-empty. */
function validState(v: unknown): v is JevPayload["state"] {
  if (!isPlainObject(v)) return false;
  for (const [k, value] of Object.entries(v)) {
    if (!Object.hasOwn(JEV_STATE_MAX_CHARS, k)) return false;
    const max = JEV_STATE_MAX_CHARS[k as keyof typeof JEV_STATE_MAX_CHARS];
    if (!isString(value, 0, max)) return false;
  }
  return isString(v.workspaceName, 1, JEV_STATE_MAX_CHARS.workspaceName);
}

function dailyCalls(env: Env): number {
  const n = Number.parseInt(env.JEV_DAILY_CALLS ?? "", 10);
  return Number.isSafeInteger(n) && n >= 0 ? n : DEFAULT_DAILY_CALLS;
}

/** POST to TypeSafe, retrying 429/529 once. Throws on network failure. */
async function callUpstream(env: Env, key: string, body: string) {
  const url = `${env.JEV_UPSTREAM_URL ?? DEFAULT_UPSTREAM_URL}/v1/systemone`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if ((res.status === 429 || res.status === 529) && attempt === 0) {
      await res.body?.cancel();
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      continue;
    }
    return res;
  }
}

export type JevOutcome =
  | "served"
  | "method"
  | "too_large"
  | "ip_limited"
  | "bad_request"
  | "stale"
  | "bad_signature"
  | "id_limited"
  | "not_configured"
  | "over_budget"
  | "upstream_error"
  | "bad_answer";

/** Coarse, content-free facts about one request: all that is ever logged. */
interface Telemetry {
  outcome: JevOutcome;
  response: Response;
  options?: number;
  confidence?: number;
  upstreamMs?: number;
  upstreamStatus?: number;
  /** An error name only, never a message. */
  error?: string;
}

type Extra = Partial<Omit<Telemetry, "outcome" | "response">>;

function result(
  outcome: JevOutcome,
  status: number,
  error: string,
  extra: Extra = {},
): Telemetry {
  return { outcome, response: fail(status, error), ...extra };
}

function confidenceBand(c: number): string {
  if (c < 0.4) return "<0.4";
  if (c < 0.6) return "0.4-0.6";
  if (c < 0.8) return "0.6-0.8";
  return ">=0.8";
}

/**
 * Observability: one `console.log` line per request, for Workers Logs and its
 * Query Builder (traces add the subrequest timings). Only the fields below,
 * never request or response content (names, prompts, folder ids or
 * descriptions, the pub key, IPs).
 */
function record(t: Telemetry, ms: number): void {
  console.log(
    JSON.stringify({
      event: "jev",
      outcome: t.outcome,
      status: t.response.status,
      ms,
      options: t.options,
      band:
        t.outcome === "served" && t.confidence !== undefined
          ? confidenceBand(t.confidence)
          : undefined,
      upstream_ms: t.upstreamMs,
      upstream_status: t.upstreamStatus,
      error: t.error,
    }),
  );
}

export async function handleJevFolder(
  request: Request,
  env: Env,
): Promise<Response> {
  const start = Date.now();
  const t = await runJevFolder(request, env);
  record(t, Date.now() - start);
  return t.response;
}

async function runJevFolder(request: Request, env: Env): Promise<Telemetry> {
  if (request.method !== "POST")
    return result("method", 405, "method not allowed");
  const declared = Number(request.headers.get("Content-Length"));
  if (declared > JEV_MAX_BODY_BYTES) {
    return result("too_large", 413, "body too large");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > JEV_MAX_BODY_BYTES) {
    return result("too_large", 413, "body too large");
  }

  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (!(await env.JEV_LIMITER.limit({ key: `jevip:${ip}` })).success) {
    return result("ip_limited", 429, "too many requests");
  }

  const bad = (error: string, extra?: Extra) =>
    result("bad_request", 400, error, extra);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return bad("malformed JSON");
  }
  if (!isPlainObject(body)) return bad("expected an object");
  if (body.v !== 1) return bad("unsupported version");
  const pub = decodeBytes(body.pub, 32);
  if (!pub) return bad("bad pub");
  const ts = body.ts;
  if (typeof ts !== "number" || !Number.isSafeInteger(ts)) return bad("bad ts");
  const sig = decodeBytes(body.sig, 64);
  if (!sig) return bad("bad sig");
  const { options, state } = body;
  if (!validOptions(options)) return bad("bad options");
  if (!validState(state)) return bad("bad state");
  const n = Object.keys(options).length;

  if (Math.abs(Date.now() - ts) > MAX_CLOCK_SKEW_MS) {
    return result("stale", 401, "stale timestamp", { options: n });
  }
  if (!verifyJevRequest(pub, ts, { state, options }, sig)) {
    return result("bad_signature", 401, "bad signature", { options: n });
  }

  const id = roomIdFor(pub);
  if (!(await env.JEV_ID_LIMITER.limit({ key: `jevid:${id}` })).success) {
    return result("id_limited", 429, "too many requests", { options: n });
  }

  const key = env.TYPESAFE_API_KEY;
  if (!key)
    return result("not_configured", 503, "jev not configured", { options: n });

  const budget = env.JEV_BUDGET.get(env.JEV_BUDGET.idFromName("global"));
  if (!(await budget.take(dailyCalls(env)))) {
    return result("over_budget", 503, "daily budget spent", { options: n });
  }

  const upstreamStart = Date.now();
  const upstreamMs = () => Date.now() - upstreamStart;
  let answer: { choice?: unknown; confidence?: unknown } | undefined;
  try {
    const res = await callUpstream(
      env,
      key,
      JSON.stringify({
        model: JEV_MODEL,
        state,
        questions: {
          pick: {
            type: "choice",
            instructions: INSTRUCTIONS,
            criteria: options,
          },
        },
      }),
    );
    if (!res.ok) {
      await res.body?.cancel();
      return result("upstream_error", 502, "upstream error", {
        options: n,
        upstreamMs: upstreamMs(),
        upstreamStatus: res.status,
      });
    }
    const parsed = (await res.json()) as {
      answers?: { pick?: typeof answer };
    } | null;
    answer = parsed?.answers?.pick;
  } catch (e) {
    return result("upstream_error", 502, "upstream error", {
      options: n,
      upstreamMs: upstreamMs(),
      error: (e as Error)?.name ?? "error",
    });
  }

  const ms = upstreamMs();
  const choice = answer?.choice;
  const confidence = Number(answer?.confidence);
  if (
    typeof choice !== "string" ||
    !Object.hasOwn(options, choice) ||
    !Number.isFinite(confidence)
  ) {
    return result("bad_answer", 502, "upstream error", {
      options: n,
      upstreamMs: ms,
    });
  }
  return {
    outcome: "served",
    response: json(200, { choice, confidence }),
    options: n,
    confidence,
    upstreamMs: ms,
  };
}
