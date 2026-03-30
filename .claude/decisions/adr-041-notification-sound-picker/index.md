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

# ADR-041: Notification Sound Picker

## Context

Currently, the notification sound setting in Manor is a simple on/off toggle (`notificationSound: boolean`). When enabled, it uses the OS default notification sound via Electron's `Notification({ silent: false })`. Users have no way to choose which sound plays.

The user wants the ability to select from different notification sounds. macOS provides built-in system sounds at `/System/Library/Sounds/` (Basso, Blow, Bottle, Frog, Funk, Glass, Hero, Morse, Ping, Pop, Purr, Sosumi, Submarine, Tink) which are a natural fit since Manor is a macOS-native Electron app.

## Decision

**Change `notificationSound` from `boolean` to `string | false`** where the string is the name of a macOS system sound (e.g. `"Glass"`) and `false` means sound is disabled.

**Approach:**
1. **Preference type change**: Update `AppPreferences.notificationSound` from `boolean` to `string | false`. Default to `"Glass"`. Existing `true` values migrate to `"Glass"`, existing `false` stays `false`.
2. **Sound playback**: In `maybeSendNotification()` in `electron/main.ts`, always set `silent: true` on the Electron Notification. When a sound is selected, use Node's `child_process.execFile` to run `afplay /System/Library/Sounds/{name}.aiff` — this is lightweight, non-blocking, and requires no dependencies.
3. **UI**: Replace the "Play notification sound" toggle row with a dropdown select. Options: "None" (disabled) plus all macOS system sounds. Include a play/preview button so users can hear the sound before selecting.

**Files to change:**
- `electron/preferences.ts` — Update `AppPreferences` interface and default
- `src/electron.d.ts` — Mirror the type change
- `src/store/preferences-store.ts` — Update default
- `electron/main.ts` — Play custom sound via `afplay` instead of relying on Electron's `silent` flag
- `src/components/NotificationsPage.tsx` — Replace toggle with sound picker dropdown
- `src/components/SettingsModal.module.css` — Add styles for the sound picker
- `electron/preload.ts` — May need to expose a `playSound` IPC for preview functionality

## Consequences

**Better:**
- Users can personalize their notification experience
- Users can preview sounds before selecting
- Uses native macOS sounds — no bundled audio files needed

**Tradeoffs:**
- macOS-only: `afplay` and `/System/Library/Sounds/` are macOS-specific. On Linux, notifications will fall back to silent (or OS default). This is acceptable since Manor currently targets macOS.
- Breaking preference change: `notificationSound` type changes from `boolean` to `string | false`. Migration handles existing values gracefully.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
