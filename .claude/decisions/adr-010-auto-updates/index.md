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

# ADR-010: Add OTA Auto-Updates via electron-updater

## Context

Manor is currently distributed as a macOS DMG with no mechanism for delivering updates to users after install. Users must manually download and reinstall new versions. As the app matures, a seamless update experience is needed.

The project already uses `electron-builder` for packaging, making `electron-updater` the natural companion library. It supports checking for updates from GitHub Releases (or S3/generic servers), downloading them in the background, and prompting the user to restart.

## Decision

Add `electron-updater` with GitHub Releases as the update source. The implementation has three parts:

1. **Main process updater module** (`electron/updater.ts`) — Wraps `electron-updater`'s `autoUpdater`. Checks for updates on app launch (with a short delay) and periodically thereafter. Sends update status events to the renderer via IPC so the UI can show download progress and a "restart to update" prompt.

2. **IPC bridge** — Add `updater:*` channels to `preload.ts` and `main.ts`:
   - `updater:checkForUpdates` — manual check trigger
   - `updater:quitAndInstall` — apply downloaded update
   - `onUpdateAvailable`, `onUpdateDownloaded`, `onUpdateError` — renderer listeners

3. **Renderer UI** — A minimal toast/banner in the existing Toast system that appears when an update has been downloaded, with a "Restart" button. No settings UI needed initially. Tell users they wont lose their sessions when updating.

4. **Build config** — Add `publish` config to `package.json` pointing to GitHub Releases. Change mac target from `dmg` to `["dmg", "zip"]` (zip is required for macOS auto-updates via Squirrel).

**Note on code signing**: macOS auto-updates require code-signed builds. This ADR sets up the code infrastructure; actual signing configuration (certificates, notarization) is a separate concern handled at CI/build time.

## Consequences

- **Better**: Users get updates automatically without manual downloads
- **Better**: Foundation for shipping frequent releases with confidence
- **Tradeoff**: Requires GitHub Releases (or alternative) as a distribution channel — builds must be published there
- **Tradeoff**: macOS auto-updates require code signing; unsigned dev builds will skip update checks gracefully
- **Risk**: First-time setup requires testing the full publish → check → download → install cycle

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
