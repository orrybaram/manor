# Mobile ↔ desktop connection: how Superset and Orca do it

> Superseded by ADR-207: Tailscale, the tunnel and the loopback listener this note describes were removed. The relay (ADR-206) is the only road.

Research date: 2026-09-30. Question: how do Superset and Orca connect a phone to the desktop app, and what zero-install options does that suggest for Manor (which today needs Tailscale or cloudflared, see [docs/remote-control.md](../remote-control.md)).

Sources are the projects' own repos, cloned at:

- Superset: `github.com/superset-sh/superset` @ `309008b4511c3febff17354d04ec3433b9c20e01` (2026-09-30)
- Orca: `github.com/stablyai/orca` @ `78daf712680e28d27657bcd54229e80916a5cc4d` (2026-09-30). Site: onorca.dev. (The "Orca" here is the Stably / YC-backed ADE; several unrelated GitHub repos share the name.)

Paths below are relative to each repo root.

---

## TL;DR

| | Superset | Orca |
|---|---|---|
| Topology | **A relay they host** (Cloudflare Workers + Durable Objects). Desktop dials out, phone dials in, relay joins the two WebSockets. | **Direct LAN WebSocket** first. **A relay they host** (GCP: Cloud Run "director" + GCE "cells") for "Anywhere" access, with automatic switch back to direct when LAN is reachable. |
| P2P / NAT traversal | None. Both sides make outbound TLS WebSockets to the relay, so NAT is never in the way. | None. Same outbound-only relay approach, plus direct `ws://` on LAN. |
| Pairing | **Account login.** The phone signs into the same Superset account and org. The desktop QR only opens the App Store. | **QR / paste code** (`orca://pair?code=…`) carrying the endpoint, a device token, the desktop's X25519 public key, and a relay invite valid for 10 minutes. The desktop must be signed in to use Relay. |
| E2E encryption | **No.** The relay terminates TLS and forwards plaintext tRPC/WS bytes (it doesn't parse them). Access control uses JWTs from api.superset.sh. | **Yes.** NaCl (tweetnacl) encrypts at the application layer, and the desktop public key is pinned by the QR. The relay only sees ciphertext. |
| Mobile client | Native iOS app (Expo / React Native), iOS 26+. No Android. | Native iOS (App Store) + Android (APK) app (Expo / React Native). Desktop also serves a web client for "runtime" scope. |
| Extra installs | None beyond the app + an account. Needs **Superset Pro**. | None beyond the app. Desktop sign-in only for Relay. |
| Off-LAN / cellular | Yes, through the relay. | Yes, through Relay. LAN-only mode also exists. |
| License | Elastic License 2.0 (relay code is source-available, not OSI). | MIT, relay included (`cloud/`). Auth/API services are in a private repo. |

---

## Superset

### Topology: a hosted relay on Cloudflare Workers + Durable Objects

- `apps/relay/wrangler.jsonc` deploys Worker `superset-relay` to `relay.superset.sh/*`, with one Durable Object class `HostTunnel` and a KV namespace `PLACEMENT`. Comments mention a "migration off the Fly relay", so they used to run it on Fly.io.
- `apps/relay/src/host-tunnel.ts:60-62`: "One Durable Object per hostId: the host's control channel plus every spliced stream terminate here. Stream traffic is never parsed." It uses `partyserver` with `static options = { hibernate: true }`, so idle sockets don't accrue Durable Object duration charges.
- Protocol (`packages/shared/src/tunnel-protocol.ts:1-4`): "one small JSON control channel per host + one raw WebSocket per proxied stream ('dial-back'). The relay asks the host to dial a fresh socket for each stream via a one-time ticket; after pairing, the relay splices bytes verbatim."
- Routes (`apps/relay/src/index.ts`):
  - `GET /v2/control?hostId=` (line 120): the desktop's long-lived control WS. It authenticates with a JWT and an API check that the host is registered.
  - `GET /v2/dial?hostId=&ticket=` (line 151): the host dials back once per stream. The single-use ticket is the credential.
  - `ALL /hosts/:hostId/trpc/*` (line 262): HTTP tRPC proxied through the DO (`proxyHttp`).
  - `GET /hosts/:hostId/*` (line 310): client WS (terminals, events). The relay mints a ticket, asks the host to dial, then splices the two sockets.
  - `GET /presence` (line 171): online/last-seen for up to 50 hosts.
- The host side is `packages/host-service/src/tunnel/tunnel-client.ts`, which uses partysocket with reconnect and a watchdog. Bodies are chunked below the DO per-message limit.
- A separate Worker, `apps/realtime` (`realtime.superset.sh`, DO `OrgHub`), fans out invalidation nudges. It is split out so that relay deploys don't drop every host socket (`apps/realtime/wrangler.jsonc` comment).

### Auth and pairing

- There's no device pairing. Everything is keyed to a **Superset account + organization**. The relay verifies a JWT issued by `https://api.superset.sh` (`index.ts:79-99`, `verifyJWT`). Per-host access (owner/member lists) is checked inside the DO (`access.ts`).
- Docs, `apps/docs/content/docs/remote-access.mdx:66-72`: enable "Allow remote access to this device via relay" on the desktop, then "On your phone, sign in with the same Superset account and select the same organization. **The QR code in desktop Mobile settings opens the App Store; it does not sign you in.**"
- Enabling the toggle restarts the host service and asks you to type a confirmation phrase (`remote-access.mdx:25`). Headless hosts can use `SUPERSET_API_KEY` + `superset start --daemon` (lines 48-57).

### Encryption

- **There is no application-layer E2E encryption.** A grep for `encrypt|nacl|libsodium|e2e` in `apps/relay/src` and `packages/host-service/src` found nothing relevant. Traffic is TLS to Cloudflare, and the relay Worker/DO sees plaintext (it "never parses" it, but it could). The docs say so: "Forwarded traffic passes through the Superset relay, like terminal traffic does" (`remote-access.mdx:107`).

### Mobile client

- `apps/mobile` is an Expo 57 / React Native app (`apps/mobile/package.json`) using better-auth (`@better-auth/expo`). Before talking to hosts it asks the API which relay URL to use (`apps/mobile/hooks/usePrimeRelayUrl/usePrimeRelayUrl.ts`).
- `apps/docs/content/docs/install.mdx:33-35`: iPhone only, iOS 26+, requires **Superset Pro**, Android waitlist. `remote-access.mdx` front-matter has `pro: true`.

### Cost / infra / license

- They run Cloudflare Workers + Durable Objects + KV, plus their own API (`api.superset.sh`) for auth/registration. The comments in `index.ts:350-356` cite about 5,600 control-socket closes an hour, which gives a sense of the fleet size.
- The license is **Elastic License 2.0** (`LICENSE.md`). The code is readable for reference but not freely reusable in a competing hosted service.

---

## Orca (stablyai/orca)

### Topology: direct LAN WebSocket plus a hosted relay

- **Direct**: the Electron main process hosts a mobile WebSocket RPC server on port **6768** (`mobile/README.md:7`). For a physical phone the endpoint is `ws://<desktop LAN IP>:6768` (`mobile/README.md:60-62`). It is plain `ws://`. Confidentiality comes from app-layer E2EE (`src/main/runtime/e2ee-keypair.ts:1-3`: "the E2EE keypair enables application-layer encryption between mobile and desktop over plain ws://").
- **Relay ("Anywhere")**: `cloud/README.md:3-9`: "Phones and desktops never talk to each other directly: each opens an outbound WebSocket to a relay cell, the relay pairs the two sessions, and it splices frames between them. A director assigns hosts to cells and coordinates migrations; cells carry the user connections."
  - Infra: a Cloud Run director, GCE "cells" in `us-central1` and `asia-east2`, and Cloud SQL Postgres, all driven by Terraform (`cloud/infra/terraform`, `cloud/docs/orca-relay-operations.md:3`, `docs/reference/relay-regional-placement.md`). The desktop probes region latency and asks for a preferred region.
  - Splicing: `cloud/apps/relay/src/splice-forwarder.ts`. Wire contract: `cloud/packages/relay-contract/src/*`, covering control messages, invite create/created, device credentials, and resume tokens.
  - A separate push gateway (`cloud/apps/push`, Cloud Run) sends APNs/FCM. The desktop authenticates to it with its X25519 key, and phones hold no Orca credential (`cloud/README.md:33-40`).
- **Path selection on the phone**: it connects direct first and runs the relay as fallback, upgrading back to direct when it can. See `mobile/src/transport/host-logical-client.ts`, `mobile-direct-endpoint-probe.ts`, `mobile-relay-direct-upgrade-controller.ts`, and `pairing-candidate-race.ts`.
- **NAT traversal**: none (no STUN/TURN/WebRTC/hole-punching). The relay works because both sides connect outbound.

### Pairing and auth

- The desktop mints a pairing offer (`src/main/runtime/runtime-rpc/runtime-rpc-pairing.ts:125-191`) encoded as `orca://pair?code=<base64url JSON>` (`src/shared/pairing.ts:14-27`). The phone scans the QR, follows a deep link, or pastes the code.
- Offer schema (`src/shared/mobile-relay-pairing-offer.ts:46-80`): `endpoint`, `deviceToken`, `publicKeyB64` (the desktop's Curve25519 key, "pinned by the pairing offer"), and an optional `relay` object `{ directorUrl, cellUrl, assignmentEpoch, relayHostId, inviteToken, inviteExpiresAt (≤10 min), e2eeFraming: 2 }`.
- The phone redeems the one-time `inviteToken` at the relay and then holds rotating **resume credentials** (`cloud/packages/relay-contract/src/credential-messages.ts`, `RelayAuthSchema`, `DeviceCredentialInstallSchema`). In the code I found no account sign-in on the phone side. The desktop must be signed in: `src/shared/mobile-pairing-connection-mode.ts:16-41` ("Anywhere cannot be committed without a signed-in desktop session for Relay"), and `cloud/docs/orca-relay-operations.md:20` ("The relay is automatically active for entitled signed-in desktops").
  - *Discrepancy, unverified:* the troubleshooting section of onorca.dev/docs/mobile says "make sure your desktop and phone are signed into the same Orca account". The main section on the same page says "sign-in is required for Relay only". The code suggests only the desktop signs in. The troubleshooting line may be stale.
- Revocation: `revokeMobileDevice` removes the device, queues a relay credential revoke, and unregisters push (`runtime-rpc-pairing.ts:88-108`).

### Encryption

- `src/shared/e2ee-crypto.ts`: NaCl `box` (X25519 + XSalsa20-Poly1305), with `deriveSharedKey = nacl.box.before(...)`.
- `src/shared/mobile-e2ee-v2-framing.ts:12-26`: v2 frames use `nacl.secretbox` with a per-session key, a session id, a direction, and a 64-bit counter bound into the nonce. That gives replay and reflection protection.
- The relay sees only ciphertext. The desktop key is pinned through the QR, so the relay can't MITM.

### Mobile client

- `mobile/` is a React Native / Expo app (`mobile/app.json`: bundle id `com.stably.orca.mobile`, v0.0.51). iOS ships through the App Store and Android as an APK on GitHub Releases (onorca.dev/docs/mobile, in beta).
- For `runtime` scope the desktop can also hand out a **web client URL** (`createWebClientUrl` in `runtime-rpc-pairing.ts:185-188`; `src/renderer/src/web/web-e2ee.ts`), so a browser client exists too.
- Orca also detects Tailscale addresses and suggests Tailscale when a remote runtime is unreachable (`src/shared/remote-runtime-tailscale-hint.ts`). Docs mention editing a host's address "when the desktop moves between home LAN and Tailscale". Tailscale is optional, not required.

### Cost / infra / license

- They run GCE VMs, Cloud Run, Cloud SQL, DNS, and observability. That's 25 ops workflows in `.github/workflows/cloud-*.yml`, and those are gated off in the public repo (`cloud/README.md:71-83`). Auth/API services live in a private `stablyai/orca-cloud` repo (`cloud/README.md:100-103`). Pricing for Relay: **unverified**. The "entitled" wording suggests an entitlement check, but I found no public price.
- License: **MIT** (`LICENSE`, © Lovecast Inc.), which explicitly covers `cloud/` (`cloud/README.md:9-10`). That makes the relay contract and E2EE framing reusable.

---

## How Manor does it today (for context)

- Docs: `docs/remote-control.md`. Design: `docs/decisions/adr-161-remote-control-relay/index.md`.
- Code: `electron/remote-control/` (`server.ts`, `listener-routes.ts`, `devices.ts`, `sse.ts`, `push.ts`, `static.ts`, `tunnel.ts`, `tunnel-status.ts`). UI: `src/components/settings/RemoteControlPage.tsx`, `RemoteControlDialogs.tsx`. Store: `src/store/remote-control-store.ts`.
- How it works: a separate HTTP listener bound to `127.0.0.1`, exposed by shelling out to either `tailscale serve --https=443` or `cloudflared tunnel --url` (`electron/remote-control/tunnel.ts:61-74,98-99`). Manor detects these tools but installs neither.
- The client is a PWA served by the desktop itself (`static.ts`). Pairing is a QR with a 32-byte per-device token in the URL fragment. Live updates go over **SSE** (`electron/remote-control/sse.ts:48`), and notifications use Web Push (VAPID).
- **Possible bug, worth checking:** Cloudflare's docs say "Quick Tunnels do not support Server-Sent Events (SSE)" and cap each quick tunnel at 200 in-flight requests ([TryCloudflare docs](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)). Manor's cloudflared path may therefore not stream live updates.

---

## Options for Manor (zero extra installs)

Requirement: the user installs nothing beyond Manor itself, and on the phone at most opens a URL / PWA (or a Manor app if one is ever built).

### A. Hosted relay with E2E encryption (the Orca model, on Superset-style infra). **Recommended.**
- **How it works:** Manor dials an outbound WSS to `relay.<manor domain>`. The phone PWA dials the same relay, and the relay splices the two sockets by host id. NAT doesn't matter and cellular works.
- **Infra:** a Cloudflare Worker + one Durable Object per host with WebSocket Hibernation, which is exactly Superset's design (`apps/relay/src/host-tunnel.ts`). DO duration isn't billed while hibernated, and WS messages are billed at 20:1 against requests (Workers Paid: 1M requests/month included, then $0.15/M; 400k GB-s included) ([DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [WS hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)). SQLite-backed DOs also run on the free plan. For a terminal-scrollback use case this is plausibly a few dollars a month.
- **Auth without accounts:** pair by QR as Manor already does. Put the desktop's X25519 public key, a relay host id, and a short-lived invite token in the URL fragment. Encrypt everything end to end (NaCl box/secretbox, or WebCrypto ECDH + AES-GCM in the PWA) so the relay is just a dumb pipe and never sees scrollback. That keeps ADR-161's "the token is a second factor" property even though the relay is public. Orca's `src/shared/mobile-e2ee-v2-framing.ts` and `cloud/packages/relay-contract` are MIT-licensed references.
- **Gotchas:** the PWA must be served from a stable HTTPS origin (the relay's domain or a static host), not from the desktop, so there's a real supply-chain/trust boundary in serving JS that holds E2E keys. Pin it with SRI or versioned builds. Web Push keeps working (VAPID is independent of transport). This is new infra Manor would have to operate.

### B. WebRTC DataChannel with hosted signaling + TURN fallback
- **How it works:** the PWA and Electron both have WebRTC built in, so no installs. Signaling can run over the same tiny Worker/DO. DTLS gives E2E encryption, and with the QR you can pin the desktop's certificate fingerprint.
- **NAT:** STUN handles most cases. Symmetric NAT and carrier CGNAT need TURN. Cloudflare Realtime TURN costs **$0.05/GB** egress, is anycast, and offers UDP/TCP/TLS on 443 ([docs](https://developers.cloudflare.com/realtime/turn/)).
- **Tradeoffs:** traffic is direct P2P when it works, which saves relay bandwidth. But it needs more moving parts (ICE restarts on network change, mobile Safari backgrounding kills peer connections), and you still need a server for signaling. Neither Superset nor Orca chose this.

### C. Embedded Tailscale (tsnet / libtailscale) + Funnel
- `tsnet` is Go only. `libtailscale` is a C archive/shared lib built from Go ([README](https://github.com/tailscale/libtailscale)). Both need a tailnet: auth key or interactive login ([tsnet KB](https://tailscale.com/kb/1244/tsnet)). So the **user still needs a Tailscale account** even though nothing extra gets installed.
- To skip the phone app, use **Funnel** (`tsnet.Server.ListenFunnel` exists, [pkg.go.dev](https://pkg.go.dev/tailscale.com/tsnet)). Funnel serves a public `*.ts.net` HTTPS URL that visitors reach without Tailscale. But it requires MagicDNS + HTTPS enabled, a funnel node attribute, only ports 443/8443/10000, and "non-configurable bandwidth limits" ([Funnel KB](https://tailscale.com/kb/1223/funnel)). The URL is public, which brings back the cloudflared trust model.
- Verdict: removes the install but not the account or setup. It also ships a Go runtime sidecar inside Electron.

### D. Bundle `cloudflared` and use quick tunnels
- No Cloudflare account is needed, but quick tunnels have "no uptime guarantee", are "for testing and development", give a new hostname on every start, cap at 200 in-flight requests, and **don't support SSE** ([TryCloudflare](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)). Since the hostname changes, the pairing QR changes on every restart.
- Named tunnels fix stability but need a Cloudflare account, either the user's or Manor's, with Manor minting per-user tunnels via the API (this is effectively option A run by Cloudflare). The binary is Apache-2.0 (verify before bundling) and about 30–40 MB per arch (**unverified**).
- Verdict: the cheapest stopgap, but not production-grade, and it's the public-URL threat model ADR-161 already flags as weaker.

### E. iroh
- QUIC P2P with hole-punching and relay fallback, E2E encrypted through relays. Its docs say "roughly 9 out of 10" networks allow direct connections ([iroh relays](https://docs.iroh.computer/concepts/relays)). n0's public relays are for "development and testing" only and rate-limited, so production means running your own relay.
- **In a browser (the PWA), iroh is relay-only**: "All connections from browsers… need to flow via a relay server" ([WASM docs](https://docs.iroh.computer/deployment/wasm-browser-support)). For a phone browser client it reduces to option A with Rust/WASM complexity. It only gets interesting if Manor ships a native mobile app.

### F. LAN-only (mDNS / direct IP)
- Zero infra and zero installs, but it fails the cellular requirement. iOS Safari also can't do mDNS discovery from a web page. Worth keeping as a fast path (Orca does direct-first, relay-fallback), not as the main solution.

### Suggested direction
Option A, modeled on Orca's pairing/E2EE and Superset's Cloudflare DO relay. It removes Tailscale and cloudflared entirely, works on cellular, keeps Manor's per-device QR pairing (just add a desktop public key + invite), and keeps the relay blind to scrollback. Keep the existing loopback listener and route allowlist (`electron/remote-control/listener-routes.ts`). The relay just becomes a new "tunnel" kind that `tunnel.ts` dials outbound. Optionally keep a direct-LAN fast path later. That would need an ADR (next free number on the target branch; ADR numbers collide across branches).

### Unverified / open items
- Orca Relay pricing and whether the phone ever needs an account (code says no, one doc line says yes).
- Superset's exact relay cost and fleet size.
- `cloudflared` license/binary size for bundling.
- Whether Manor's current cloudflared path actually breaks on SSE in practice (the Cloudflare docs say SSE is unsupported; not tested here).
