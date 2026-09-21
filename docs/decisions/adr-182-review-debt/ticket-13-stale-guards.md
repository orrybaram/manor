---
title: Delete stale web guards and the one-member TunnelKind
status: done
priority: medium
assignee: sonnet
blocked_by: [12]
---

# Delete stale web guards and the one-member TunnelKind

ADR-182 D11, cleanup half.

## Stale settings guards
- `HomeSettingsPage.tsx:~11-14` and `ProjectSettingsPage.tsx:~267-270` disable their fields on web, with a "not editable from the browser yet" banner, because "`preferences.set` / `projects.update` isn't on the slice-1 bridge table".
- Both methods are on the table and are not local-only. Delete the `isWebApp()` branches and the banners.
- `preferences-store.ts:~60-67`: delete the dead `handleBridgeUnavailable("preferences-set-unavailable", …)` catch.

## Keybindings store
- `keybindings-store.ts` has two back-to-back JSDoc blocks (~32 and ~38). Delete the stale first one.
- Add `const resolve = (o) => resolveBindings(o, navigator.platform, { inBrowser: isWebApp() })` to replace the 5 repeats.
- Add one `persist(promise)` helper to replace the 3 repeated catches.
- The toast is unreachable, because `KeybindingsPage` disables the controls on web. Drop it.

## Remote control page
- Fix the stale comment at `RemoteControlPage.tsx:~108-111`.
- Route `handlePair` (~126-139) through the store's shared busy/error wrapper, as every other action does.
- Disable the label input on `locked`, matching its button.
- Use `EmojiInput` for the device label, per `.claude/rules/ui-components.md`.

## Tunnel kind
- `TunnelKind` has one member, `"tailscale"`. In `electron/remote-control/tunnel.ts`, the route and `RemoteControlPage`, delete:
  - `kind`
  - `URL_PATTERNS` keyed by kind
  - `preferredKind()`
  - `isTunnelKind`
  - the `startTunnel(kind?)` parameter
- Replace `detected` with `installed: boolean`.
- Resolve the tailscale binary once, not on every 10-second poll (~209).

## Duplicated web setup
- `main.tsx` and `web-main.tsx` share their QueryClient and root-render setup through one helper.
- `WEB_CSP` is duplicated between `electron/remote-control/static.ts:~47` and `src/web.html`. Make one the source and generate the other, or document why it can't be, if the build prevents it.

## Files to touch
- `src/components/settings/{HomeSettingsPage,ProjectSettingsPage,RemoteControlPage,KeybindingsPage}.tsx`, `src/store/{preferences-store,keybindings-store,remote-control-store}.ts`
- `electron/remote-control/tunnel.ts`, `electron/routes/system.ts`, `electron/remote-control/static.ts`, `src/main.tsx`, `src/web-main.tsx`, `src/web.html`, and the tests
