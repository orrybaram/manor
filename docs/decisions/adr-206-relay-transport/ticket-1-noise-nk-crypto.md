---
title: Noise NK channel crypto
status: done
priority: critical
assignee: opus
blocked_by: []
---

# Noise NK channel crypto

ADR-206 D2. A self-contained module that both the desktop (Node) and the web
app (browser) import. **Cryptographic code: nothing else goes in this
ticket**, and nothing outside this module may touch keys or nonces directly.

## What to build

`src/lib/relay-crypto/` — pure TypeScript, no Node or DOM imports, so the web
bundle and Electron main both take it.

- **Dependencies:** add `@noble/curves`, `@noble/ciphers`, `@noble/hashes`.
- **`noise.ts`** — `Noise_NK_25519_ChaChaPoly_SHA256`, per the Noise spec
  (rev 34): `SymmetricState` (`mixKey`, `mixHash`, `encryptAndHash`,
  `decryptAndHash`, `split`), `CipherState` (64-bit nonce counter, rekey not
  needed; refuse to encrypt past 2^64-1). Two roles:
  - `createInitiator(responderStaticPub, prologue)` → `writeMessage1()`, then
    `readMessage2(msg)` → `{ send: CipherState, recv: CipherState }`.
  - `createResponder(staticKeyPair, prologue)` → `readMessage1(msg)`, then
    `writeMessage2()` → `{ send, recv }`.
  - Prologue is `"manor-relay-v1"` so a transcript from any other protocol
    cannot be replayed into this one.
- **`channel.ts`** — `SecureChannel` over a finished handshake:
  `seal(plaintext: Uint8Array): Uint8Array`, `open(ciphertext): Uint8Array`
  (throws on auth failure — the caller closes the channel; never retry).
  Max plaintext 65 535 − 16 bytes per Noise message; `sealFrame(text)` splits a
  larger UTF-8 frame into chunks with a 1-byte `more` flag and `openFrame`
  reassembles, capped at 1 MiB total (the bridge's `MAX_FRAME_BYTES`).
- **`keys.ts`** — `generateRelayIdentity()` → `{ ed25519: {pub, priv}, x25519:
  {pub, priv} }`; `roomIdFor(ed25519Pub)` =
  `base64url(sha256(pub)).slice(0, 22)`; `signHostChallenge(priv, roomId,
  challenge)` / `verifyHostChallenge(pub, roomId, challenge, sig)` over
  `"manor-relay-host-v1" ‖ roomId ‖ challenge`; base64url helpers.
- **`index.ts`** — the public surface; nothing else is exported.

## Tests

`src/lib/relay-crypto/__tests__/`:

- The NK vectors for `25519_ChaChaPoly_SHA256` from the cacophony test vector
  set (vendor the relevant JSON entries into `__tests__/vectors/` with a
  comment naming the source). Handshake messages and the first transport
  messages must match byte for byte.
- Round trip initiator ↔ responder; a tampered byte fails `open`; a
  substituted responder key fails `readMessage2`; reordered messages fail
  (nonce mismatch); chunking at boundaries (exactly max, max+1, 1 MiB, 1 MiB+1
  rejected).
- Host challenge: valid signature verifies; wrong room id, wrong key, or a key
  that does not hash to the room fails.

## Files to touch
- `package.json` — the three `@noble/*` deps
- `src/lib/relay-crypto/{index,noise,channel,keys}.ts` — new
- `src/lib/relay-crypto/__tests__/*` — new
