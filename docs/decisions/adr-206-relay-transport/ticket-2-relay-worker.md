---
title: The relay Worker — rooms, host auth, channels, limits
status: done
priority: critical
assignee: opus
blocked_by: []
---

# The relay Worker — rooms, host auth, channels, limits

ADR-206 D1. A Cloudflare Worker in `relay/` that pipes bytes between one host
and a few viewers per room. It must never parse a payload.

## What to build

- `relay/` as its own package: `package.json` (wrangler, `@cloudflare/workers-types`,
  `@cloudflare/vitest-pool-workers`, vitest), `wrangler.toml`, `tsconfig.json`,
  `src/index.ts`, `src/room.ts`. Add `relay` to a `pnpm-workspace.yaml`
  `packages:` list (keep the existing `onlyBuiltDependencies`). Root scripts:
  `relay:dev` (`wrangler dev`), `relay:test`, `relay:deploy`.
- **Routing (`index.ts`):** `GET /host/:roomId` and `GET /join/:roomId`
  upgrades go to the Durable Object `Room` named by `roomId` (validate: 22
  base64url chars, else 404). `GET /app/*` is ticket 6's — leave a stub that
  404s. Everything else 404.
- **`Room` Durable Object** using the WebSocket Hibernation API
  (`state.acceptWebSocket`, tags `host` / `viewer:<n>`):
  - Host: on accept send `{t:"challenge", c:<b64u 32 bytes>}` (text). Expect
    `{t:"auth", pub, sig}` within 5 s. Verify `roomIdFor(pub) === roomId` and
    the Ed25519 signature (import `verifyHostChallenge` / `roomIdFor` from
    `src/lib/relay-crypto` — share the code, do not reimplement; configure
    the relay's tsconfig/bundler to resolve it). On success reply
    `{t:"ok"}`; a previous host socket is closed 4409 "replaced". Persist the
    challenge in the socket attachment so hibernation survives it.
  - Viewer: refused 4404 if no authenticated host; 4429 if
    `MAX_CHANNELS` (8) viewers are open or the daily byte budget is spent.
    Otherwise assign the lowest free channel 1..65535 and send the host a
    binary `[OP_OPEN, ch_hi, ch_lo]`.
  - Data: viewer → host: prefix `[OP_DATA, ch_hi, ch_lo]`. Host → viewer:
    read the 3-byte header, forward the rest to that channel's viewer. Host
    `[OP_CLOSE, ch]` closes that viewer (1000); a viewer closing sends the
    host `[OP_CLOSE, ch]`. Host disconnect closes every viewer 4404.
  - Viewer messages must be binary; text from a viewer closes it 1003.
  - Limits: 1 MiB per message (close 1009), byte budget counted both
    directions in DO storage keyed by UTC day (default 2 GiB, `RELAY_DAILY_BYTES`
    var).
- **Rate limiting:** a `ratelimits` binding (`JOIN_LIMITER`) on `/join` keyed
  by `CF-Connecting-IP`; over the limit → 429 before upgrade.
- Ops constants in one `src/protocol.ts` (OP codes, close codes, limits) that
  ticket 4's connector imports too — put it at `src/lib/relay-crypto/protocol.ts`
  or `relay/src/protocol.ts` re-exported; pick the one both bundles can import
  and say so in the file header.

## Tests

`relay/test/` with `@cloudflare/vitest-pool-workers`: host auth success,
bad signature, key/room mismatch, auth timeout; join with no host (4404);
open/data/close round trip on two channels with bytes unchanged; host
replacement; channel cap; message size cap; text from viewer rejected; host
drop closes viewers.

## Files to touch
- `relay/**` — new
- `pnpm-workspace.yaml` — add `packages`
- `package.json` — root scripts
