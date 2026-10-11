---
title: Electron image proxy trust and viewer name boundary
status: done
priority: medium
assignee: sonnet
blocked_by: [12]
---

# Electron image proxy trust and viewer name boundary

- `electron/github.ts:851-860` and `electron/linear.ts:404-412` both check the URL is trusted, then pass that same check into `fetchImageDataUrl` as `isTrusted`.
- `gh auth token` cache (`imageTokenPromise`, `imageToken()`, reset on `ImageAuthError`; github.ts ~175, 863-884) is self-contained.
- `getViewerFirstName` / `firstNameOf` (github.ts ~829-846, 889; `electron/bridge/handlers/integrations.ts:75,344`) put the phone greeting's first-name logic in GitHubManager and cache it in main AND in `src/components/phone/useViewerFirstName.ts`.
- `github.ts` grew 1142 → 1164; it should shrink.

Do:
1. `electron/image-proxy.ts` `fetchImageDataUrl` throws when the initial URL is untrusted; delete the callers' duplicate guards (GitHub keeps only its URL rewrite). Update `image-proxy.test.ts`.
2. Move GitHub image token cache + `proxyImage` to `electron/github-images.ts`; GitHubManager delegates (or the bridge handler calls it directly — whichever keeps the handler table simplest).
3. Main exposes `getViewerName()` (raw profile name, no cache) instead of `getViewerFirstName`; update the bridge contract (`integrations.ts`, `src/electron.d.ts`, ElectronAPI placement per ADR-180 D7 — build fails if a method isn't placed). `firstNameOf` moves to the phone layer; `useViewerFirstName` owns splitting + the single cache.
4. Update `electron/github.test.ts`.

## Files to touch
- `electron/image-proxy.ts` (+test)
- `electron/github.ts` (+test), `electron/github-images.ts` (new)
- `electron/linear.ts`
- `electron/bridge/handlers/integrations.ts`
- `src/electron.d.ts`
- `src/components/phone/useViewerFirstName.ts`
