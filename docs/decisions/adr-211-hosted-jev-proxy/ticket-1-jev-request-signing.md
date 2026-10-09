---
title: Shared Jev request signing in relay-crypto
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Shared Jev request signing in relay-crypto

Read Decision 2 of `docs/decisions/adr-211-hosted-jev-proxy/index.md`.

In `src/lib/relay-crypto/keys.ts`, beside `signHostChallenge` / `verifyHostChallenge`:

- `const JEV_REQUEST_CONTEXT = utf8("manor-jev-v1")`.
- `canonicalJson(value: unknown): string`: JSON with object keys sorted recursively, no whitespace. Only plain objects, arrays, strings, numbers, booleans and null are allowed; anything else throws `RelayCryptoError`. Export it; the worker needs it to hash the body it received.
- `jevRequestMessage(ts: number, payload: { state: unknown; options: unknown })` is `concatBytes(JEV_REQUEST_CONTEXT, utf8(String(ts)), utf8("\n"), sha256(utf8(canonicalJson(payload))))`. The `"\n"` separates the variable-length ts from the fixed-length hash. Require `ts` to be a non-negative safe integer, or throw.
- `signJevRequest(ed25519Priv, ts, payload): Uint8Array`.
- `verifyJevRequest(ed25519Pub, ts, payload, sig): boolean`. It never throws, and verifies with `zip215: false` like the host-challenge verifier.

Export the new functions from `src/lib/relay-crypto/index.ts` the way the host-challenge pair is exported.

Tests go in `src/lib/relay-crypto/__tests__/` (follow the existing keys test file there). Cover:

- A sign/verify round trip.
- `canonicalJson` is key-order independent: the same payload with its keys reordered verifies.
- Verification fails after tampering with `ts`, `state` or `options`, or with the wrong key.
- Garbage input returns false.

Run `pnpm typecheck` and the test file.

## Files to touch
- `src/lib/relay-crypto/keys.ts`
- `src/lib/relay-crypto/index.ts`
- `src/lib/relay-crypto/__tests__/<keys test file>`: extend, or add `jev-request.test.ts`
