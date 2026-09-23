---
title: Make the bridge the only surface for full devices
status: done
priority: critical
assignee: sonnet
blocked_by: []
---

# Make the bridge the only surface for full devices

ADR-182 D2.

## Change the tier mapping
- `electron/remote-control/allowlist.ts`: `allowedKeys("full")` returns the `send` set, the same as `send`. `remoteRouteTable` is then a plain filter for every tier.
- Delete the `null` handling and the doc comments that justify "full = the whole table".
- A `full` device keeps full power over `/ws`, where the bridge's `LOCAL_ONLY_METHODS` and audit apply.

## Delete the separate HTTP path for full
In `electron/remote-control/server.ts`, delete:
- the `full` branch of `guardWrites`
- `fullTierWrite`
- `fullTierTarget`
- `READ_ONLY_POSTS`
- `DELETE` in `ALLOWED_METHODS`, if only `full` needed it (check this)

In `electron/remote-control/audit.ts`, delete the `tier: "full"` variant, if nothing else emits it.

## Keep the web app working
The web app talks over `/ws`. Confirm it needs no HTTP write routes:
- grep `src/bridge/transports/ws.ts`, `src/web-main.tsx` and `src/bridge/install-web.ts` for `fetch(`
- keep whatever static, auth or pairing routes they use in the right tier

## Tests
- Update `electron/remote-control/__tests__/allowlist.test.ts` and `server.test.ts`.
- Add a test: a `full` token calling `POST /remote-control/enabled` over HTTP gets 403 or 404, whichever the listener uses for a route outside the tier's table.

## Docs
Update `docs/remote-control.md` and the ADR-178 D3 wording (add a note: "amended by ADR-182 D2").

## Files to touch
- `electron/remote-control/allowlist.ts`, `server.ts`, `audit.ts`, their tests
- `docs/remote-control.md`, `docs/decisions/adr-178-web-app-and-single-bridge/index.md` (a one-line amendment note only)
