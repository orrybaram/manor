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

# ADR-161: Remote control surface — check on agents from a phone

## Context

An agent goes `requires_input` and sits there. If you are not at the machine, you find
out when you come back. The interesting failure mode of parallel agents is not that they
crash — it is that they quietly wait, and waiting is invisible from anywhere but the
desk.

`dcolinmorgan/herdr-remote` (a third-party companion to herdr, not herdr itself) solves
this with a relay on port 8375 that polls the `herdr` CLI, accepts pushes from remote
instances via a `herdr-push` plugin, and fans state out over WebSocket to a macOS menu
bar app, a Cloudflare-tunneled web dashboard, and a Telegram bot with `/agents`, `/read`,
`/send`, `/reply`, `/trust`, `/interrupt`, and `/digest`. Its security model is origin
validation plus loopback-by-default, with an optional `HERDR_RELAY_TOKEN` for managed
installs.

Manor needs none of the polling. The API already exists. `WebviewServer`
(`electron/webview-server.ts`) runs an HTTP listener in Electron main, and
`electron/routes/` serves exactly the surface a phone client wants:

- `GET /tasks`, `GET /context`, `GET /panes` — the read surface
- `POST /sessions/read` — scrollback for a task handle or raw pane id
- `POST /sessions/send` — type into a session, with an interrupt override
- `POST /panes/split`, `POST /panes/:paneId/focus`, `DELETE /panes/:paneId`
- project, issue, and agent-launch routes

That is already reachable through the `manor` MCP server, which is a thin stdio proxy
over the same HTTP endpoints (`electron/mcp-webview-server.ts`). The work here is not
building an API. It is making an existing API safe to expose, and putting a client on it.

**The security position is the whole ADR.** `WebviewServer` listens on `127.0.0.1` with a
random port written to `~/.manor/webview-server-port`, and has **no authentication of any
kind** — loopback is the entire boundary. That is a defensible choice for a local
MCP/CLI surface. It is not survivable through a tunnel: `POST /sessions/send` types
arbitrary text into a live shell, and the agent-launch and pane routes spawn processes.
Exposing today's listener to the internet, even behind an obscure hostname, is remote code
execution with extra steps. Origin validation of the kind herdr-remote relies on does not
help — it is a browser-enforced control, and `curl` does not enforce it.

So the shape is forced: a _second_, authenticated listener with an explicit route
allowlist, rather than auth bolted onto the existing one. Two listeners with two threat
models beats one listener with a mode flag, because the failure mode of a mode flag is
that someone forgets to check it on one route.

## Decision

Add an opt-in, authenticated remote-control listener, a tunnel integration the user
starts deliberately, and a small mobile web client. Ship read-only first; gate writes
behind a second decision.

### 1. Separate listener, separate threat model

`electron/remote-control/server.ts`: a new `http.Server` on its own port, **off by
default**, started only when the user enables remote control. `WebviewServer` is not
modified — the local loopback surface keeps working exactly as it does for MCP and the
CLI, with no auth, because nothing about its exposure changes.

The new listener reuses `electron/routes/`'s `dispatch()` and `ControlDeps` so route
handlers are written once, but it passes a **filtered route table**, not `routes`. A
route reaches the remote surface only by being named in the allowlist:

```ts
// electron/remote-control/allowlist.ts
export const REMOTE_READ_ROUTES = [
  "GET /tasks",
  "GET /context",
  "GET /panes",
  "POST /sessions/read",
];
export const REMOTE_WRITE_ROUTES = ["POST /sessions/send"]; // gated, see §4
```

The read list is shorter than the inventory above suggests, because two of those
endpoints are not what their prefix implies: `/agents` exists only as
`POST /agents`, which _launches_ a process, and `/tabs` only as `POST /tabs`,
which creates one. Neither is a read, so neither reaches the surface; the
session list the client renders is `GET /tasks`.

Everything else — project mutation, issue fan-out, agent launching, pane split/close —
is absent from the remote surface in v1. Not "returns 403": absent, because a route that
is never in the table cannot be reached by a bug in an auth check. `router.test.ts`
already asserts properties of the route table; add an assertion that the remote table is
a strict subset of the local one and that no route outside the allowlist is present.

### 2. Authentication

Bearer token in an `Authorization` header, verified with
`crypto.timingSafeEqual` on equal-length buffers (length-check first, and compare hashes
rather than raw tokens so length is not itself an oracle).

- Tokens are **per-device**. Pairing generates a 32-byte random token, displays it as a
  QR code containing `https://<tunnel-host>/#<token>`, and stores a SHA-256 of it plus a
  label and creation time. The raw token is shown once and never persisted.
- Storage goes through `safeStorage.encryptString` into `manorDataDir()`, matching the
  established pattern in `electron/linear.ts:57-69`. Add `remoteDevicesFile()` to
  `electron/paths.ts` — app-internal state, so `manorDataDir()`, not `manorHomeDir()`.
- Each device can be revoked individually, and revocation is immediate (the token hash
  set is the live lookup, not a cached copy).
- Rate-limit auth failures per source address with a small in-memory counter and
  exponential backoff, and log them so a user can see something is knocking.
- Reject any request without a valid token before the body is read, and before routing.

`Origin`/`Host` checks are added on top for browser-initiated requests, but as
defence in depth — never as the boundary.

### 3. Tunnel

The listener binds `127.0.0.1` even when enabled. Reaching it from outside is the
tunnel's job, and the tunnel is **user-initiated, never automatic**.

Support two paths, detected rather than bundled:

- **Cloudflare Tunnel** — if `cloudflared` is on `PATH`, offer to run a quick tunnel and
  capture the assigned hostname from its output. This is what herdr-remote uses.
- **Tailscale** — if `tailscale` is on `PATH`, prefer it and offer `tailscale serve`. It
  is the better default when available: the device is already authenticated at the
  network layer, so the bearer token becomes a second factor rather than the only one.

Manor does not ship or auto-install either binary, and does not start one at launch.
Starting a tunnel is an outward-facing action; it gets an explicit confirmation that
names what becomes reachable, and the UI shows a persistent indicator while it is live.
Stopping Manor stops the tunnel.

### 4. Read first, then writes

v1 ships the read surface. `POST /sessions/send` — the one route that can act — lands
behind all of:

- an explicit per-device "allow sending" capability, off by default, set at pairing time;
- a confirmation in the client showing the exact text and the target session;
- an audit log entry (`electron/remote-control/audit.ts`, append-only, in `manorDataDir()`)
  recording device label, target, and a hash of the text.

Interrupt (`interrupt` override on the same route) is treated as a write.

### 5. Client

A single static page served by the listener at `/`, built as part of the renderer bundle
into `dist-electron/remote/`. No framework beyond what the app already has; no external
CDN. It reads the token from the URL fragment on first load, moves it into
`localStorage`, and strips the fragment.

Views: a list of sessions with agent status (`idle` / `thinking` / `working` /
`requires_input` / `error`, from the existing `AgentStatus` union), tap to read
scrollback, and — when the device holds the capability — a send box.

Live updates over Server-Sent Events (`GET /events`, token-authenticated) rather than
WebSocket: the payload is one-directional status fan-out, and it is meaningfully less
code. Fall back to polling `GET /tasks` on a 5s interval if the stream drops.

The client reads that stream with `fetch` and a `ReadableStream` rather than with
`EventSource`. `EventSource` cannot set an `Authorization` header, and the only
alternative — the token in a query string — would write the credential into every proxy
log between the phone and the machine. Parsing the SSE framing by hand is about thirty
lines, and the reconnect/backoff logic was needed for the polling fallback regardless.

### 6. Push

The point of the feature is being told, not checking. Web Push from the same listener,
subscribed per device, fired when a session transitions to `requires_input` or `error` —
Manor already computes exactly this transition for its dock badge and OS notifications
(`electron/notifications.ts`, `maybeSendNotification` in `app-lifecycle.ts`), so this is a
second sink on an existing signal, not new detection logic.

Telegram is deliberately **not** in scope. herdr-remote's bot is the most-demoed part of
it, but it means handing a third party a channel that can type into your shell, and Web
Push covers the actual need without that.

### Relationship to ADR-160

None, and that is the point. This ADR touches `electron/routes/` and a new
`electron/remote-control/` module; ADR-160 touches the daemon, the transport, and
`electron/backend/`. They can land in either order. If both land, the remote-control
surface reports on remote-host sessions for free, because it reads through `taskManager`
and `ControlDeps`, which ADR-160's registry already feeds.

## Consequences

**Better.** The thing that makes parallel agents expensive — an agent silently blocked
while you are away — becomes a push notification. It reuses an API that already exists
and is already exercised by the MCP server, so the marginal surface is a listener, an
auth check, and a page. And the route-allowlist split leaves Manor with a clear internal
distinction between "local trusted surface" and "surface we would expose", which is a
useful boundary to have named even if the tunnel is never turned on.

**Worse.** Manor gains a second HTTP listener, a token store, an audit log, and a
static client bundle to maintain, plus a tunnel subprocess lifecycle to get right —
including the case where `cloudflared` dies and the UI must stop claiming to be
reachable. Two route tables can drift; the subset assertion in `router.test.ts` is what
keeps that honest and it must not be allowed to rot. Web Push needs a VAPID key pair,
which is one more secret in `safeStorage`.

**Risks.** This is the first Manor feature whose failure mode is someone else's shell.
The specific hazards: a route added to `electron/routes/` in future work silently
appearing on the remote surface (mitigated by allowlist-not-blocklist, and by the test);
timing-unsafe token comparison (mitigated by comparing hashes with `timingSafeEqual`);
a token leaking through the URL fragment into a browser history or a screenshot of the QR
code (mitigated by per-device revocation and by keeping send capability off by default);
and a user leaving a quick tunnel running indefinitely without realising (mitigated by
the persistent indicator and tunnel-stops-with-app). The `/sessions/read` route returns
raw scrollback, which routinely contains secrets — that is not a mitigable property of
the feature, it _is_ the feature, and it is the reason the auth story has to be right
rather than convenient.

Anyone reviewing the implementation should treat §2 and §1's allowlist as the parts that
matter, and be unsympathetic about them.

### Decisions taken during implementation

Four things landed differently from the sketch above, each for a reason worth recording.

**Two of the "read" routes did not exist.** `/agents` exists only as `POST /agents`,
which launches a process, and `/tabs` only as `POST /tabs`. Neither is a read, so the
remote read surface is `GET /tasks`, `GET /context`, `GET /panes`, and
`POST /sessions/read`. The allowlist test asserts every entry resolves to a real route,
so a rename cannot silently shrink the surface again.

**The app shell is served without authentication.** It has to be: the pairing token
arrives in the URL fragment, which browsers never send to a server, so the page must load
before it can present a token. What is reachable unauthenticated is HTML, CSS, and a
bundle — no session data, no device list, no token — and everything that reads or changes
state stays behind the auth pipeline. Path containment is resolve-then-verify against the
client directory, tested directly rather than through `fetch` (which normalises `..` away
before a server ever sees it).

**Three routes are the listener's own, not allowlist entries.** `GET /me` (the calling
device's own label and send capability, plus the public VAPID key), `GET /events`, and
`POST /push/subscribe` are answered by the listener itself, not dispatched into
`electron/routes/`. They are enumerated in `LISTENER_OWN_ROUTES` and asserted not to
shadow anything in the real table, so "what is reachable" is still one file to read.

**Enablement is not persisted.** Remote control is off at every launch. A stored
"enabled" flag that reopens a listener after an update is the kind of surprise this
feature cannot afford, and re-ticking a box costs a second.

### Found in review, not fixed

- **An unauthenticated caller can request the app shell repeatedly.** Static serving sits
  ahead of the rate limiter, because the limiter keys on authentication failures and the
  shell has none. The cost is bounded file reads from one directory; nothing is disclosed
  beyond "this machine runs Manor".
- **A hard kill of Manor can orphan the tunnel child.** `stop()` runs on `before-quit` and
  a synchronous `SIGKILL` runs on `process.on("exit")`, which covers `app.exit()` and
  fatal errors — but nothing runs when Manor is itself `SIGKILL`ed. The exposure indicator
  cannot help there either, since it dies with the app.
- **A cloudflared quick-tunnel hostname is effectively public.** That is inherent to the
  tool; it is why Tailscale is preferred and why the confirmation dialog names the
  difference.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
