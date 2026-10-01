# Manor relay

A Cloudflare Worker with one Durable Object per desktop
([ADR-206](../docs/decisions/adr-206-relay-transport/index.md)). It pipes
Noise ciphertext between a desktop (the **host**) and up to 8 browsers
(**channels**) in a **room**, and serves the web app from R2, one build per
version. It cannot read what it forwards. For what it can and cannot see, see
[docs/remote-control.md](../docs/remote-control.md#the-manor-relay).

```
GET /host/<roomId>      desktop; challenge-response with its Ed25519 key
GET /join/<roomId>      viewer; 4404 if no host is connected
GET /app/<version>/*    the web app build for that Manor version, from R2
```

`roomId` is `base64url(sha256(ed25519PublicKey))[0..22]`.

## Limits

All enforced in the room (`src/room.ts`) except the rate limit:

- 1 MiB per message; larger closes the socket with 1009. (A desktop frame may
  be up to 32 MiB; it crosses as several messages.)
- 8 channels per room. Channel numbers rotate over 1..65535 rather than reuse
  the lowest free one, so a departed viewer's in-flight frames cannot reach
  the next viewer.
- A per-room byte budget per UTC day, both directions: `RELAY_DAILY_BYTES` in
  `wrangler.toml`, default 2 GiB. When spent, new joins get 4429 until the day
  rolls.
- A host that has not authenticated within 5 s is closed (4408).
- Heartbeat: host and viewers send the text `ping` every 20 s and the room
  answers `pong` itself (Durable Object auto-response, no wake-up). A live
  socket silent for 90 s is closed with 4410 by an alarm; a join whose host is
  silent gets 4404 at once.
- Every host binary message is acknowledged with `OP_ACK` (`[0x04, 0, 0,
  u32 length]`); the desktop keeps a bounded window of unacknowledged bytes
  and schedules its viewers fairly inside it.
- `/join` and `/host` are rate limited per client IP by the `JOIN_LIMITER`
  binding (30 per 60 s each, keyed `join:<ip>` / `host:<ip>`). Its
  `namespace_id` must be unique in the Cloudflare account.

## Close codes

Relay codes: 4401 host auth failed, 4404 viewer with no host, 4408 host auth
timeout, 4409 host replaced by a newer one, 4410 no heartbeat, 4429 channel
cap or daily budget.

Of the desktop's bridge verdicts, only **4401** (bad or revoked token) and
**4403** (device paired below `full`) pass through to the viewer; anything else
reaches it as a normal close. The relay's 4404, 4410 and 4429 mean
"unreachable", not "your credentials are bad", and the page treats them that
way. Revoking a device
on the desktop closes its live channel immediately.

## Deploying

The release workflow does this (`.github/workflows/release.yml`): it builds the
web app with `MANOR_WEB_BASE=/app/<version>/` (`pnpm build:web:relay`), uploads
it (`node scripts/upload-web-relay.mjs --remote`), and runs `pnpm relay:deploy`.
It needs the repository secrets `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`; without them the step skips with a warning, so forks
still release.

Once, by hand, in the Cloudflare account:

- Create the R2 buckets `manor-relay-web` (production) and
  `manor-relay-web-dev` (what `wrangler dev` binds locally).
- Make sure the rate limiter `namespace_id` in `wrangler.toml` is unused in the
  account.
- Have the `manor.sh` zone in the same Cloudflare account. The Worker is
  served at `relay.manor.sh` as a custom domain (`routes` in `wrangler.toml`),
  so `wrangler deploy` creates the DNS record and certificate; there is no
  record to add by hand. The desktop's `DEFAULT_RELAY_URL` in
  `electron/remote-control/relay/connector.ts` names the same origin.

## Local development

The `wrangler` CLI needs **Node >= 22**.

```sh
pnpm build:web:relay      # web build with base /app/<version>/
pnpm relay:dev:upload     # into the local preview bucket manor-relay-web-dev
pnpm relay:dev            # wrangler dev, state in relay/.wrangler/state
MANOR_RELAY_URL=ws://localhost:8787 pnpm dev   # point the desktop at it
```

`MANOR_RELAY_URL` overrides the default relay; `ws://` is accepted only for
localhost. Uploading a full build takes about 45 s: it runs one wrangler process
per file, and parallel uploads crash workerd's SQLite.

For debugging, `wrangler dev --var RELAY_DEV_PAYLOAD_LOG:1` makes the room log
every payload it forwards, and only for requests addressed to loopback. It
exists for the e2e blindness check; never set it in `wrangler.toml`.

## Tests

```sh
pnpm relay:test        # vitest in workerd (@cloudflare/vitest-pool-workers)
pnpm test:e2e:relay    # builds, then drives a real desktop and browser through it
```

`relay:test` runs under Node 20 (vitest-pool-workers hosts workerd itself); the
e2e spawns the wrangler CLI, so it needs Node >= 22 on `PATH`. See `tests/e2e/README.md` for the e2e fixture.
