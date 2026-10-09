---
title: Relay Worker /jev/folder route with limits and daily budget
status: todo
priority: high
assignee: opus
blocked_by: [1]
---

# Relay Worker /jev/folder route with limits and daily budget

Read Decisions 1–3 of `docs/decisions/adr-211-hosted-jev-proxy/index.md`, and `relay/README.md`.

## `relay/src/jev.ts`

`export async function handleJevFolder(request: Request, env: Env): Promise<Response>` does these steps in order:

1. **Method and size.** Anything but POST gets 405. Read the body as text; over 16 KiB gets 413.
2. **IP limit.** Get the IP from `CF-Connecting-IP` and call `env.JEV_LIMITER.limit({ key: "jevip:" + ip })`; on failure, 429.
3. **Parse and validate.** Malformed input gets 400 with a short reason. Check:
   - `v === 1`
   - `pub` decodes (`base64urlDecode`) to 32 bytes
   - `ts` is a safe integer
   - `sig` decodes to 64 bytes
   - `options`: a plain object with 2–64 entries, keys matching `/^[A-Za-z0-9_-]{1,64}$/`, string values of 1–400 chars
   - `state`: a plain object containing only `workspaceName` (required, 1–200), `branchName` (optional, ≤200) and `agentPrompt` (optional, ≤2000), all strings
4. **Freshness.** If `|Date.now() - ts| > 5 * 60_000`, answer 401.
5. **Signature.** If `verifyJevRequest(pub, ts, { state, options }, sig)` fails, answer 401. Import it from `../../src/lib/relay-crypto`, the way `room.ts` does.
6. **Identity limit.** `env.JEV_ID_LIMITER.limit({ key: "jevid:" + roomIdFor(pub) })`; on failure, 429.
7. **Secret.** If `env.TYPESAFE_API_KEY` is unset, answer 503.
8. **Budget.** Call `env.JEV_BUDGET.get(env.JEV_BUDGET.idFromName("global"))` and its RPC method `take(limit)`. If it returns false, answer 503 `{ error: "daily budget spent" }`.
9. **Call TypeSafe.**
   - Request: `POST https://api.typesafe.ai/v1/systemone` with `Authorization: Bearer ${env.TYPESAFE_API_KEY}`, `Content-Type: application/json` and body `{ model: JEV_MODEL, state, questions: { pick: { type: "choice", instructions: INSTRUCTIONS, criteria: options } } }`.
   - `INSTRUCTIONS` is the instructions string that `buildFolderQuestion` in `electron/folder-suggestion.ts` uses today. Copy it verbatim. `JEV_MODEL = "jev-1.13.0"`.
   - Use `signal: AbortSignal.timeout(4000)`, and retry once after 300 ms on 429/529.
10. **Reply.**
    - Read `answers.pick.choice` and `answers.pick.confidence`.
    - If `choice` is not a key of `options`, or the call failed, answer 502.
    - On success, answer 200 `{ choice, confidence: Number(confidence) }` with `Content-Type: application/json` and `Cache-Control: no-store`.
    - **Never log request bodies.** Log only status-level errors.

## `JevBudget` Durable Object

Add it to `relay/src/jev.ts`, or `relay/src/jev-budget.ts` if cleaner.

- Use the SQLite-backed storage KV API, as `Room` does.
- `async take(limit: number): Promise<boolean>`:
  1. Read the key `count:<YYYY-MM-DD UTC>`. If it is `>= limit`, return false.
  2. Otherwise increment, write and return true.
  3. Delete keys from earlier dates when you write; there will only ever be one or two.
- The Durable Object's input gate makes this race-free, so no locking is needed.
- Export the class from `relay/src/index.ts` alongside `Room`, since wrangler needs the export.

## Wiring

**`relay/src/index.ts`:** before `ROUTE_PATTERN`, route `url.pathname === "/jev/folder"` to `handleJevFolder`.

**`relay/src/env.ts`:** add these, with doc comments in the existing style:
- `JEV_LIMITER: RateLimit`
- `JEV_ID_LIMITER: RateLimit`
- `JEV_BUDGET: DurableObjectNamespace<JevBudget>`
- `JEV_DAILY_CALLS?: string`
- `TYPESAFE_API_KEY?: string`
- `JEV_UPSTREAM_URL?: string`: a test seam, defaulting to `https://api.typesafe.ai`.

Parse the daily cap from `JEV_DAILY_CALLS` with a fallback of 5000.

**`relay/wrangler.toml`:**
- `JEV_DAILY_CALLS = "5000"` under `[vars]`.
- A Durable Object binding `JEV_BUDGET` with class `JevBudget`.
- A migration `{ tag = "v2", new_sqlite_classes = ["JevBudget"] }`.
- Two `[[ratelimits]]`:
  - `JEV_LIMITER`: namespace_id `"2062"`, 60 per 60 s
  - `JEV_ID_LIMITER`: namespace_id `"2063"`, 20 per 60 s
- A comment saying the key is set with `wrangler secret put TYPESAFE_API_KEY` and never goes in this file.

**`relay/test/env.d.ts`:** update it if the test env typing needs the new bindings. Check how `room.test.ts` gets its env (vitest-pool-workers, and possibly `relay/vitest.config.ts` bindings or miniflare options). Give the test env a fake `TYPESAFE_API_KEY` and point `JEV_UPSTREAM_URL` at a stub (or mock `fetch`), whichever the pool supports.

**`relay/README.md`:**
- Add `POST /jev/folder` to the route list.
- Add a "Jev" subsection under Limits: the 3 limits, plus "never logs bodies; sees folder/workspace names and agent prompts in cleartext".
- Add the secret step under Deploying.

## Tests

Write `relay/test/jev.test.ts`, following `relay/test/room.test.ts` and `helpers.ts`. Sign requests with `signJevRequest` and a generated identity. Cover:

- The happy path, checking the exact upstream body, including the fixed model and instructions.
- A bad signature gets 401.
- A stale `ts` gets 401.
- Oversized or invalid `options` get 400.
- An unknown upstream choice gets 502.
- The budget is spent at the limit: set `JEV_DAILY_CALLS` to 2 for the test, and the third call gets 503.
- A missing secret gets 503.

Run `pnpm relay:test` and `pnpm typecheck`.

## Files to touch
- `relay/src/jev.ts` (+ optional `relay/src/jev-budget.ts`): new
- `relay/src/index.ts`: route and export
- `relay/src/env.ts`: bindings
- `relay/wrangler.toml`: vars, DO, migration, ratelimits
- `relay/vitest.config.ts`, `relay/test/env.d.ts`: test env if needed
- `relay/test/jev.test.ts`: new
- `relay/README.md`: docs
