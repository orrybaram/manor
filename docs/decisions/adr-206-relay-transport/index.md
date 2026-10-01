---
type: adr
status: accepted
database:
  schema:
    status:
      type: select
      options: [todo, in-progress, review, done]
      default: todo
    priority:
      type: select
      options: [critical, high, medium, low]
    assignee:
      type: select
      options: [opus, sonnet, haiku]
  defaultView: board
  groupBy: status
---

# ADR-206: Reaching the machine without installing anything — an end-to-end encrypted relay

Builds on the ADR-178 → ADR-181 stack (#217–#220) and assumes ADR-180's
**Bridge** (one handler table, frames, transports). Background research:
`docs/research/mobile-connection-superset-orca.md`.

## Context

Every surface the stack built — the web app at `/app`, the remote client at
`/`, server-owned layout, the phone layout — is reached the same way: the
remote-control listener binds `127.0.0.1`, and `tailscale serve` makes it
reachable. That works, and its security story is good (the tailnet is a
network-level first factor; the device token is the second). Its setup story
is not: Tailscale on the desktop, Tailscale on the phone, both signed into the
same account, Serve enabled on the tailnet. Most people who want to glance at
an agent from their phone will not do four installs-and-sign-ins to get there.

Two comparable products avoid this with a hosted relay that both ends dial
*out* to, so no NAT traversal and no install beyond the client:

- **Superset** — a Cloudflare Worker + Durable Object relay
  (`relay.superset.sh`) that pipes the two WebSockets together. Pairing is
  "sign into the same account". **No end-to-end encryption**: the relay sees
  plaintext.
- **Orca** — LAN-direct first, then a hosted relay for "anywhere", with a QR
  that carries the desktop's public key and NaCl end-to-end encryption on top,
  so the relay only sees ciphertext. Desktop must be signed in to use it.

We want Superset's shape (Worker + Durable Object, nothing to install) with
Orca's security property (the relay cannot read a session), and **no account
on either end** — the QR pairing the stack already has is the identity.

Two facts in the current code make this smaller than it looks:

1. **The bridge is already transport-agnostic.** ADR-180 D2 says a further
   transport "is a file in `src/bridge/transports/`". The browser side
   (`src/bridge/transports/ws.ts`) and the host side
   (`electron/bridge/transports/ws.ts`) speak JSON frames over *some* socket,
   authenticate with a `hello` frame carrying the device token, and know
   nothing about how bytes got there.
2. **Authentication is a frame, not a URL** (`electron/bridge/transports/ws.ts`
   header). So if an encrypted channel delivers that same `hello` frame, the
   existing `DeviceVerifier`, backoff and `full`-only rule run unchanged.

And one fact makes it bigger: the web app's bytes are currently served *by the
desktop, through the tunnel*. If the relay is to be blind, the page cannot come
through it as HTTP — the browser needs an origin that serves the bundle and
holds the TLS certificate. That origin is something we host, and it must serve
the build matching the desktop's version.

## Decision

### D1 — The relay is a blind pipe: one Durable Object per desktop

`relay/` (new, in this repo) is a Cloudflare Worker deployed with `wrangler`.
Each desktop has a **room**: one Durable Object, addressed by the desktop's
relay id. The room holds at most one **host** socket and up to
`MAX_CHANNELS` (8) **viewer** sockets, using the WebSocket Hibernation API so
an idle room costs nothing.

- `GET /host/<roomId>` (upgrade) — the desktop. The room sends a random
  32-byte challenge; the desktop answers with an Ed25519 signature over
  `"manor-relay-host-v1" ‖ roomId ‖ challenge`. `roomId` is
  `base64url(sha256(ed25519PublicKey))[0..22]`, and the public key rides in the
  answer, so the room checks both that the key hashes to the room and that the
  signature verifies. No account, no registration, and nobody can squat a room
  they do not hold the key for. A second valid host replaces the first (the
  laptop that woke up is the live one).
- `GET /join/<roomId>` (upgrade) — a viewer. Refused (close 4404) if no host is
  connected; otherwise assigned a channel number and announced to the host.
- **Framing.** Host-side messages are binary: a 1-byte op (`open`, `data`,
  `close`), a 2-byte channel, then payload. Viewer-side messages are the bare
  payload; the room adds or strips the header. The room never parses a
  payload — it cannot; they are ciphertext (D2).
- **Limits**, all in the room: 1 MiB per message (the bridge's own
  `MAX_FRAME_BYTES`), `MAX_CHANNELS` viewers, a per-room daily byte budget
  (default 2 GiB, then new joins get 4429 until the UTC day rolls), an
  unauthenticated host socket closed after 5 s, and Cloudflare's
  rate-limiting binding on `/join` per client IP. These bound what an
  anonymous relay can be abused for; they are not the security boundary.

The Worker also serves the web app (D4) from the same origin, so the page's
`connect-src 'self'` covers the relay socket with no CSP change.

### D2 — End-to-end: Noise NK, then the existing `hello`

Each viewer channel is an independent **Noise `NK_25519_ChaChaPoly_SHA256`**
session. NK is "initiator anonymous, responder's static key known in
advance": the phone learns the desktop's X25519 static public key from the
QR (D3), so it authenticates the desktop and gets forward secrecy, and a
relay that substitutes its own key fails the handshake.

The phone is authenticated *inside* the channel, by the thing that already
authenticates it: once the handshake completes, the first transport message is
the bridge's `{"type":"hello","token":…}`. From there every bridge frame is one
Noise transport message. Nothing above the channel changes.

Implemented once, in `src/lib/relay-crypto/` — pure TypeScript over
`@noble/curves` (X25519, Ed25519), `@noble/ciphers` (ChaCha20-Poly1305) and
`@noble/hashes` (SHA-256, HKDF), which run unchanged in Node and the browser
and are audited. No Noise library: the NK pattern is two messages, and the
module is tested against the published Noise test vectors for that suite.

Rejected: NaCl `box` with a static-static key (Orca's shape) — no forward
secrecy, and the phone would need a long-term key registered at pairing,
which is a second credential with the same storage as the token. Rejected:
Noise `IK`/`KK` (phone has a static key) — same reason; it adds a credential
without adding a factor.

### D3 — Pairing: the QR carries the room, the key and the token

Relay identity — an Ed25519 key (room auth) and an X25519 key (Noise static) —
is generated on first relay start and stored like the device tokens: through
`safeStorage` in `manorDataDir()`, file `remote-relay-identity.enc`, mode 0600.
Refusing to store it when encryption is unavailable matches
`RemoteDeviceStore`.

A device paired for the relay gets the link

```
https://<relay-origin>/app/<version>/#relay=<roomId>.<x25519PubB64u>&t=<token>
```

Everything after `#` never reaches a server — not the Worker, not Cloudflare's
logs. The page stores it in `localStorage` (per origin, so every version shares
it) and strips the fragment, exactly as `install-web.ts` does today.

**Relay pairing is `full` only.** The relay carries the bridge, and the bridge
refuses anything below `full` (ADR-178: a smaller bridge is a second surface to
keep honest). The remote client at `/` speaks HTTP routes and SSE, which do
not travel over the relay. So the pairing dialog, with the relay selected,
shows Everything and says why. Opening a `read`/`send` tier on the bridge is a
follow-up ADR, not this one.

"Reset relay address" regenerates both keys: a new room, every relay link dead
at once. That is the relay's equivalent of revoking everything.

### D4 — The web app is served by the relay's origin, one build per version

The desktop no longer serves the page for relay viewers, so the Worker does,
from an R2 bucket laid out `app/<version>/…`. `vite.web.config.ts` takes its
`base` from `MANOR_WEB_BASE` (default `/app/`, unchanged for the listener), and
the release workflow builds a second copy with `base: /app/<version>/` and
uploads it. R2 rather than Workers Static Assets because a deploy replaces the
whole asset set, and old desktops must keep finding their own build.

Version skew is handled in the handshake: the host's `hello` reply gains
`appVersion`. A page whose own `__APP_VERSION__` differs navigates to
`/app/<appVersion>/` (credentials are already in same-origin storage), so a
link bookmarked before an update still lands on the matching renderer. A
version with no uploaded build (a dev build) gets a stated screen, not a
blank page.

Dev: `pnpm relay:dev` runs `wrangler dev` with a local R2 bucket that
`pnpm build:web` writes into, and a `MANOR_RELAY_URL` override points the
desktop at it.

### D5 — The host side: a relay connector feeding the bridge

`electron/remote-control/relay/connector.ts` dials `/host/<roomId>`, answers
the challenge, and for each `open` creates a **channel**: a Noise responder,
then — once the handshake completes — a socket-shaped object handed to the
bridge's WebSocket server.

To make that possible, `WsBridgeServer`'s hello / auth / connection logic is
lifted off `ws`'s `WebSocket` onto a minimal `FrameSocket`
(`send(text)`, `close(code, reason)`, `onMessage`, `onClose`). The `ws` path
adapts its socket to it; the relay channel implements it. One gate, now three
transports: the `hello`, `DeviceVerifier`, backoff and 4401/4403 codes are the
same code for a relay channel as for a local socket. Relay channels
authenticate with source `relay`, which is safe for the reason
`authenticateBridge` already documents: a valid token is checked before the
backoff, so a guesser cannot lock the owner out.

Output is coalesced per channel (flush on 16 ms or 64 KiB) before encryption,
because the relay bills and rate-limits per message and PTY output is many
small frames.

Reconnect uses the same capped backoff the browser transport uses (1 s →
30 s). The connector exposes a status like `TunnelStatus`
(`stopped | starting | running | failed`, plus `url`).

### D6 — Relay is a third way to reach the machine, chosen deliberately

`RemoteControlController` gains the relay alongside the tunnel. The existing
policies carry over verbatim: **nothing starts itself** (off at launch,
not persisted), **starting it is an explicit, confirmed action** that names
what becomes reachable, the REMOTE badge shows while it is live and turns red
if it dies, and disabling remote control stops it. Tailscale stays, and stays
the recommended choice for anyone who already has it; the settings card offers
"Manor relay (no install)" and "Tailscale" as two ways to reach the machine.

The relay does not need the loopback HTTP listener — it feeds the bridge
directly — but it still requires remote control to be enabled, so there is one
switch that means "this machine can be reached".

### D7 — Push over the bridge

Today Web Push subscriptions are registered over HTTP by the remote client
(`POST /push/subscribe`), so a web-app-only relay device would never be told
an agent is waiting — the main reason to have this feature. Add a
`remoteControl.subscribePush` bridge entry (device callers only) and a service
worker to the web app. The desktop then sends pushes straight to the browser's
push service, which needs no relay at all. On iOS this requires the web app to
be added to the Home Screen; the pairing screen says so.

### D8 — Reversing the cloudflared rationale, on the record

`docs/remote-control.md` dropped the cloudflared quick tunnel because "the
token was the only thing between the internet and your session output". The
relay is also single-factor — the 256-bit device token is what admits a
phone — and this ADR accepts that, for these reasons, which did not hold for
cloudflared:

- **The relay operator cannot read anything.** With cloudflared, TLS ended at
  Cloudflare and session output crossed it in the clear. Here the relay sees
  ciphertext and channel numbers.
- **The token never leaves the encrypted channel.** It is not in a header a
  proxy can log, and it is never presented to anything but the desktop.
- **There is no unauthenticated surface on the desktop.** Nothing on the
  machine answers HTTP to the internet — no static shell, no route parsing
  before auth. A stranger who knows a room id can reach a Noise handshake,
  then a `hello` check, and nothing else.
- **It is still a choice.** Tailscale remains for anyone who wants the network
  layer as a first factor, and the settings card says which is which.

What is knowingly *not* protected: **whoever controls the relay origin serves
the web app's JavaScript**, and malicious JavaScript could exfiltrate the token
or session output after decryption. End-to-end encryption here protects
against the relay's logs, Cloudflare, and a compromised relay *process*; it does
not protect against a malicious deploy of the page. This is true of every
end-to-end-encrypted web client. A native app or a locally-installed PWA
would close it, and is out of scope.

## Consequences

**Better**

- A phone reaches Manor by scanning a QR. No Tailscale, no account, no app.
- The relay is blind: session output, keystrokes and tokens are ciphertext to
  it.
- Works on cellular and behind any NAT; both ends dial out.
- The bridge gains a socket seam (`FrameSocket`) that a future cloud host or a
  native client can use as well.

**Harder**

- **We now run infrastructure.** A Cloudflare account, a domain, R2, and a
  deploy step in the release workflow. If the relay is down, relay devices
  cannot connect (Tailscale devices are unaffected). Cost is on the Workers
  paid plan plus Durable Object duration/requests and R2 storage; coalescing
  (D5) and the byte budget (D1) keep it bounded. Verify current pricing before
  enabling it for everyone.
- **The page is served by us, per version**, so every release must upload its
  web build, and a missing upload strands that version's relay devices
  (they get the stated screen, not a broken one).
- **Relay pairing is `full` only.** Watch/Reply devices still need Tailscale
  and the remote client. The phone keyboard limitation ADR-181 records (no
  Esc/Ctrl) applies to relay phones.
- **Hand-rolled Noise NK.** Small and vector-tested, but it is cryptographic
  code we own. It gets its own ticket, its own tests, and nothing else in it.
- Push on iOS needs Add to Home Screen.

**Risks**

- A malicious or compromised deploy of the relay origin can read sessions
  (D8). Mitigation in this ADR: the relay and page are deployed only from the
  release workflow, and the docs say plainly what the relay can and cannot see.
- Durable Object message billing on chatty sessions. Coalescing mitigates;
  watch it in the first weeks.
- Room ids are guessable only by brute force (128 bits of a key hash), and a
  correct guess buys a Noise handshake and a `hello` check — nothing else.

## Tickets

1. **Noise NK channel crypto** (`src/lib/relay-crypto/`) — opus
2. **The relay Worker: rooms, host auth, channels, limits** (`relay/`) — opus
3. **`FrameSocket`: the bridge's hello gate off `ws`** — sonnet
4. **Relay identity and the host connector** — opus · blocked by 1, 2, 3
5. **Browser relay transport, pairing fragment, version redirect** — opus · blocked by 1, 3
6. **Per-version web builds served from R2** — sonnet · blocked by 2
7. **Settings: choosing the relay, pairing, badge, reset** — sonnet · blocked by 4
8. **Push over the bridge** — sonnet · blocked by 5
9. **E2E: pair and drive a terminal over a local relay** — opus · blocked by 4, 5, 6, 7, 11, 12
10. **Docs and vocabulary** — haiku · blocked by 9
11. **Pass bridge close codes through the relay** — opus · blocked by 2, 4, 5 (found in ticket 4)
12. **Revoking a device closes its live connections** — sonnet · blocked by 7, 11 (found in tickets 7, 11)

<div data-type="database" data-path="." data-view="board"></div>

## Amendments after review

Protocol and transport changes made after code review, before first release.
`src/lib/relay-crypto/protocol.ts` is the source of truth for every number.

- **Channel allocation rotates.** The room hands out channel numbers in
  rotation over 1..65535 (next after the last one given, skipping open ones,
  persisted across hibernation), not lowest-free. A host frame in flight for a
  viewer that just left can no longer land on the next viewer given the same
  number.
- **A bad message 2 no longer forgets the pairing.** A genuine key mismatch
  fails on the desktop at message 1, and a reset desktop is a different room
  (4404), so a message 2 that does not authenticate is treated as misrouted
  bytes: the page reconnects. Only `KEY_MISMATCH_THRESHOLD` (3) in a row, with
  no good handshake between, end dialling — as `CLOSE_KEY_MISMATCH`, which
  asks to re-pair (`onKeyMismatch`) without deleting credentials.
- **Heartbeat and reaping.** Host and viewers send the text `ping` every 20 s;
  the room answers `pong` through the Durable Object auto-response (no
  wake-up) and an alarm reaps any live socket silent for 90 s with 4410. A
  join that finds its host stale drops it and gets 4404 at once. The browser
  treats an interval with nothing back, a desktop that never answers message
  1, and 4410 as *unreachable* (the overlay), not a silent retry.
- **Directional frame caps.** Browser → desktop frames stay at 1 MiB (the
  bridge's inbound cap). Desktop → browser frames may be up to 32 MiB
  (`MAX_HOST_FRAME_BYTES`), so a long scrollback's `pty.create`, a full diff
  or an image no longer kills the channel; they cross the relay as several
  ≤ 1 MiB messages. A non-final frame chunk must be exactly full, and chunks
  per frame are bounded, so a frame of empty chunks cannot pile up work.
- **Flow control.** The room acknowledges every host message (`OP_ACK`, its
  length). The connector keeps at most a 512 KiB window unacknowledged and
  drains per-channel queues into it round-robin, one ≤ 256 KiB message per
  turn; Noise message 2, `OP_CLOSE` and heartbeats skip the queues. A busy
  pane no longer delays another viewer's echo or a new viewer's handshake by
  the whole backlog (which sat in kernel buffers `bufferedAmount` cannot see).
  A viewer more than 8 MiB behind is closed (1000) and reconnects to a fresh
  snapshot. Liveness counts any inbound message, so acks keep a socket
  behind a backlog alive. A relay channel's hello window is 20 s.
- **Limits.** Before its first frame a viewer may send at most 64 KiB. The
  host socket refuses compression and messages over 1 MiB + header, and holds
  at most 16 channels. `/host` is rate-limited per IP like `/join`. The daily
  byte count is flushed 1 s after any uncounted byte, so it survives
  hibernation.

## Amendments after rebase

Rebuilt on main after ADR-205 made the remote-control runtime lazy (§3):

- **The relay is part of the lazy runtime.** `RelayConnector` and
  `RelayIdentityStore` (which pull in `ws` and the Noise crypto) are built in
  `app-lifecycle.ts`'s `loadRemoteControlRuntime`, beside the listener, the
  tunnel manager and the WebSocket bridge they attach to;
  `RemoteControlRuntime` carries them as `relay` / `relayIdentity`, and the
  controller no longer takes them in its constructor. Before the runtime
  loads, `status()` reports a stopped relay with no viewers.
- **No relay transition loads the runtime except Reset relay address.** Start
  relay and relay pairing need remote control enabled (so the runtime is
  already loaded); stop is a no-op without it; a reset is an explicit user
  action and loads it to reach the identity.
- **Ordering.** The disable path drops the controller's `wantEnabled` intent
  before its first await, and relay and tunnel starts check it — the role
  the original `disabling` flag played. Relay transitions still run one at a
  time (`serially`); enable/disable keep ADR-205's own concurrency.
- `vapidPublicKey` is async, since `web-push` loads lazily (ADR-205).
