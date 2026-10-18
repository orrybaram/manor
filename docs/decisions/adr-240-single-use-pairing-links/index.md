---
type: adr
status: proposed
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

# ADR-240: Single-use pairing links

## Context

Settings → Devices → Add device shows a QR code and a link, `https://<relay>/app/<v>/#relay=<roomId>.<x25519Pub>&t=<token>`, whose `t` is the device's long-lived token. That token is a bearer credential for the whole machine (ADR-207 D4: no tiers, a paired device can type into any shell), it never expires, and any number of browsers can use it at once under one device row. So the link itself is the machine: a copy left in Messages, Slack, a clipboard manager, Universal Clipboard, a screenshot of the QR, or a screen share during pairing keeps working for whoever finds it, until the device is revoked — and once that browser has said hello to the desktop, the desktop mints it host pairings too (ADR-228 D9), which keep working while the laptop sleeps.

Everything after the link is already sound: the fragment never reaches a server, the relay is blind (ADR-206), the store keeps only a hash, and revoke cuts live channels. The weak point is that the thing a person handles is the long-lived secret.

## Decision

The link carries a **Pairing ticket**: single use, valid for 10 minutes. The device chooses its own long-lived token and sends it, with the ticket, in its first hello; the desktop redeems the ticket by storing that token's hash, and the ticket is dead. The long-lived token never appears in a URL, a QR code, the desktop UI or a server reply.

### D1. Link and hello

- Link: `https://<relay>/app/<v>/#relay=<roomId>.<x25519Pub>&ticket=<ticket>`. A ticket is 32 random bytes, base64url (43 characters, the same shape as a token, so one hash-and-compare path serves both). A link from an older desktop keeps `&t=<token>` and still works. A fragment with both `t` and `ticket` is `invalid`.
- Hello, browser → server: `{ "type": "hello", "token": <string>, "ticket"?: <string>, "previousId"?: <string> }`. A browser holding a ticket sends both; the token is one it generated itself (`crypto.getRandomValues`, 32 bytes, base64url).
- `RelayGate.authenticate(token, hello)`: `verify(token)` first; if that fails and `hello.ticket` is a string, `redeem(ticket, token)`; if both fail, the existing backoff path and 4401. A redeem logs `pairing link redeemed by "<label>"` (never the ticket).
- `HelloReplyFrame` is unchanged and `BRIDGE_PROTOCOL_VERSION` stays 1: the only protocol change is one optional hello field.
- After its first accepted hello the browser drops the ticket from storage and stops sending it.

### D2. Data model (`electron/remote-control/devices.ts`)

- `RemoteDevice.tokenHash: string | null` — null while the device is pending.
- `RemoteDevice.pending?: { ticketHash: string; expiresAt: number }` — present exactly when `tokenHash` is null.
- `RemoteDeviceInfo.pending?: { expiresAt: number }` — never the hash.
- `KNOWN_FIELDS` gains `pending`. `asDevice` accepts a 64-hex `tokenHash`, or a null/absent `tokenHash` with a valid `pending`; anything else is dropped. Expired pending rows are kept on load (the UI shows them).
- `PAIRING_TICKET_TTL_MS = 10 * 60_000`, overridable by the constructor option `ticketTtlMs` and env `MANOR_PAIRING_TICKET_TTL_MS` (a positive integer, read once) so the e2e can shorten it.

### D3. Store API

- `pair(label, relayRoom, options?: { direct?: boolean })` returns `{ device, ticket, expiresAt }` by default, or `{ device, rawToken }` with `direct` (today's behaviour, for D7). Persist and flush, rolling back on failure, as today.
- `reissue(id)` returns `{ device, ticket, expiresAt }` for a pending row (waiting or expired) with a new ticket; the old one is dead. It throws `"Only a device that has not connected yet can get a new link."` for anything else.
- `redeem(ticket, token): RemoteDevice | null` is **synchronous**, like `verify`. The token must match `/^[A-Za-z0-9_-]{43}$/`. It hashes the ticket and compares it against every pending row with `timingSafeEqual`, without stopping at a match. A match with `expiresAt < now`, or a token whose hash some device already has, returns null (the row stays). Otherwise it sets `tokenHash`, deletes `pending`, sets `lastSeenAt`, and calls `persist()`; a synchronous throw rolls back and returns null.
- `verify` skips rows whose `tokenHash` is null: a ticket is never a bearer token.
- `revoke` is unchanged: a pending device can be removed.

### D4. A device's states

- **Waiting** (pending, not expired) → first accepted hello carrying its ticket → **active**, until revoked.
- **Waiting** → TTL passes → **expired**. This is derived from `expiresAt`; there is no server timer.
- **Waiting / expired** → New link → **waiting**, with a new ticket.
- Any state → revoke → gone. There is no way back from active to pending: an active device whose token is lost is revoked and added again, as today.

### D5. The browser (`src/bridge/`)

- `pairings.ts`: `StoredPairing.ticket?: string`, accepted by `isStoredPairing`. `upsertTicketPairing(link, now?, mintToken?)`: if the room's stored pairing already has this ticket, bump `lastUsedAt`, undecline, and keep its token; otherwise store `{ …existing, serverKey, token: mintToken(), ticket }`. Keeping the token for a ticket already seen is what lets two tabs of one browser share one token: one hello redeems, the other verifies. `clearPairingTicket(roomId, ticket)` deletes the field while it still matches. `freshDeviceToken()` base64url-encodes 32 random bytes.
- `web-pairing.ts`: `parseFragment` returns `{ kind: "ticket", link }` for `ticket=`; `readPairing` stores it through `upsertTicketPairing` and strips the fragment as today. `TOKEN_PATTERN` is unchanged; it only guards fragments that do not start with `relay=`.
- `transports/ws.ts`: `WsTransportOptions.ticket?: string | null`; `sayHello` adds it while held; it is cleared on the first accepted hello.
- `install-web.ts`: `open()` passes `pairing.ticket`; `onHello` calls `clearPairingTicket` before `recordPairingHello`. `syncPairings` (which redials when a room's stored token changes) is safe by construction: a redeem never changes the token.

### D6. Devices page (desktop)

- `DeviceRow`: active rows read as today. A waiting row reads "Waiting for the device to open the link · expires in N min" with a **New link** button (`data-testid="remote-device-new-link"`); an expired row reads "Link expired" with **New link**. A timer at `expiresAt` re-renders waiting into expired. The trash tooltip is "Remove this device" for a pending row; its `aria-label` stays `Revoke <label>`.
- `PairingResultDialog` says: "This link works once and expires in 10 minutes. If it expires, choose New link on the device's row." (minutes from `expiresAt`).
- New link calls `remoteControl.reissue(id)` (local-only) and reopens the dialog with the new link.
- The browser needs no new screen: a spent or expired link gets 4401 and the existing not-paired screen.

### D7. Host servers

- `remoteControl.pair(label, options?)` takes `{ direct?: boolean }` on both handler tables (one shared handler, already local-only; on a host server, owner-only).
- `HostPairingLinks.linkOne` asks for `{ direct: true }` and takes `result.rawToken`: that token goes to the phone inside its already-authenticated Noise channel, never through a URL, so a ticket would only add a round trip. A host that answers with a ticket link (an older desktop asking a newer host) links nothing, and what it minted is revoked.
- `hosts.pairDevice` (no UI, e2e only) keeps the default and so now returns a ticket link.
- `reissue` is not added to the host server's table: nothing on the box shows a link to a person.

### D8. Failure handling and migration

- The gate stays synchronous: a redeem commits in memory and queues the write, the same pattern `verify`'s `lastSeenAt` uses. Making hello asynchronous would mean guarding the frames `onMessage` routes to `onHello` while it waits.
- A used, expired or garbage ticket without a valid token is a failed auth: backoff and 4401.
- The server handles one socket's frames in order and the redeem is a synchronous map change, so exactly one hello redeems a ticket. Another browser opening the same link is refused.
- Existing devices have a `tokenHash` and no `pending`, so they are active and untouched. Browsers holding a token keep working. Links from older desktops (`t=`) still parse. Host servers use the same store class, so they follow.

### Rejected

- **Token in the hello reply** (the desktop issues the token, the reply carries it). A reply lost after the redeem strands the device with a spent ticket, a second tab of the same browser is refused during the swap, and the server starts sending a secret.
- **A restricted pending connection that must call `claim`.** A new connection state in the bridge for no gain over D1.
- **Prefixing the ticket in `t=`.** A separate `ticket=` parameter is unambiguous to every parser and makes a link from an older desktop recognisable.
- **Removing expired pending rows automatically.** The user named the device; a row that vanishes is a mystery. It reads "Link expired" with New link instead.
- **An asynchronous authenticator that awaits the write.** See D8.
- **Ticket links for host pairings the desktop mints.** See D7.
- **A client key bound to the browser (Noise IK/XK).** It would stop a token copied out of storage, which this ADR does not address. It is a larger handshake change, left for later.

### Conflicts with existing ADRs

- ADR-206 D3 defines the link as carrying the token; this ADR amends it.
- ADR-228 D9 / ADR-238: host pairings the desktop mints for a device are unchanged (direct tokens over the owner channel).

## Consequences

- A leaked link, QR screenshot or clipboard copy is useless after the device opens it, or after 10 minutes, whichever comes first. The long-lived token exists only in the browser that chose it and as a hash on the machine.
- A stranger who opens a leaked link **before** the owner does still gets in. The window is 10 minutes, the owner's own browser then shows "not paired", and the row already shows "last seen" — the docs say to revoke it.
- Pairing now has to happen within 10 minutes of showing the link; New link covers the rest.
- If the queued write of a redeem fails, the device works until restart, and after it the row is pending with an expired ticket and the browser is refused — re-pair. The same class of failure as the `lastSeenAt` courtesy write.
- An older desktop against a newer host server gets ticket links it cannot read for host pairings, so phones are not linked to that host until the desktop updates. Hosts are bootstrapped by the desktop, so the window is short.
- The browser and the desktop must ship together: an older browser build opening a ticket link would not parse it. The relay serves the build matching the desktop's version, so links minted by a desktop open in a build that reads them.
- Expired pending rows stay listed until removed or given a new link.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
