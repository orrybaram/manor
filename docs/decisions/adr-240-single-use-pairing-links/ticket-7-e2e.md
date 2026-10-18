---
title: E2E - helpers, existing specs, pairing-ticket spec
status: done
priority: high
assignee: opus
blocked_by: [2, 3, 4, 5]
---

# E2E: helpers, existing specs, pairing-ticket spec

Prove ADR-240 end to end. Read `index.md` in this folder and the memory note on E2E traps if present.

- `tests/e2e/helpers/settings.ts` (:169-280): `PairedDevice { label; link; ticket: string }` (drop `token`); `completePairingDialog` and `pairHostPhone` read `ticket` from the fragment and throw if `t=` is present ("link carried a raw token"). New helper `deviceToken(page, link): Promise<string>` reading `localStorage["manor.web.pairings"]` for the link's room after the page loaded. Reuse/move the `roomOf` helper (phone-all-pairings.spec.ts ~:116). Fix every spec that used `device.token`.
- `tests/e2e/relay.spec.ts` (:282-296): hash regex `&ticket=`, `not.toContain("&t=")`; after `openWebApp`, `token = await deviceToken(...)`, assert the link does not contain it and it is 43 chars. (:411-425) relay-blindness secrets include `device.ticket` and `token`, labelled `<pairing ticket>` / `<device token>`.
- `tests/e2e/phone-all-pairings.spec.ts` (:120-132): still redeems once; assert the stored box pairing has no `ticket` after hello.
- New `tests/e2e/pairing-ticket.spec.ts` with `withLocalRelay()` (`tests/e2e/helpers/relay-fixture.ts`), plus a short-TTL variant via `appLaunch` env `MANOR_PAIRING_TICKET_TTL_MS: "4000"` (see fixtures.ts / relay-fixture.ts for the override shape):
  1. Works once; a second browser on the same link is refused; the token is never in a URL or relay traffic: pair → link has `ticket=`, no `t=`; row reads "Waiting for the device"; open → app visible; row reads last seen; second fresh-context client on the same link → `web-app-no-token`; first client reloads → still works; `findReadable(relay.payloads(), [ticket, token])` is null; the page URL has no fragment.
  2. Expired link refused, New link recovers (short TTL): row shows "Link expired"; opening the link → `web-app-no-token`; click `remote-device-new-link` → dialog with a different link → opens and works.
  3. A pending device can be removed (`revokeDevice`).
- If `scripts/test-remote-e2e.mjs` or `package.json` relay scripts enumerate spec files, add the new spec.

## Files to touch
- `tests/e2e/helpers/settings.ts`, `tests/e2e/relay.spec.ts`, `tests/e2e/phone-all-pairings.spec.ts`, `tests/e2e/pairing-ticket.spec.ts` (new), any spec using `PairedDevice.token`, `scripts/test-remote-e2e.mjs` / `package.json` if they list specs.

Acceptance: build the app first as the e2e requires, then the new spec, `relay.spec.ts` and `phone-all-pairings.spec.ts` pass.
