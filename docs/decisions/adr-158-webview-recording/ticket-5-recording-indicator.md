---
title: Recording indicator on the pane
status: in-progress
priority: medium
assignee: sonnet
blocked_by: [2]
---

# Recording indicator

While a pane is being recorded, show it. An agent can start a screen capture without the user
asking; capture the user cannot see running is not acceptable, so this ticket is part of the
feature, not a polish follow-up.

## Behaviour

- A red dot with a "Recording" label, plus elapsed time, on the browser pane chrome while capture
  is live. Place it in the pane's existing status/controls area.
- Clicking it stops the recording — the user must have a way out that does not require asking the
  agent to stop.
- Clears as soon as the recording finalizes, including on the auto-stop and error paths.

## Implementation

Recording state originates in main, so the renderer needs to be told. Add a
`recordingPaneIds: Set<string>` (or a `Map<paneId, startedAt>` if elapsed time is easier fed from
the start timestamp) to the app store, updated by the same `onRecordingCommand` subscription that
ticket 2 wires into `src/App.tsx`.

Follow `.claude/rules/ui-components.md`: the stop control is a `<Button>` from
`src/components/ui/Button/Button`, not a raw `<button>`, and any hover text uses `<Tooltip>`.

Check whether an existing pane badge pattern already covers this — the browser pane has audio-state
indicators wired through `webview:audio-state-changed` (`electron/preload.ts:558`), which is the
same problem shape. Reuse that pattern rather than inventing a second one.

## Files to touch
- `src/components/workspace-panes/BrowserPane/BrowserPane.tsx` — render the indicator; expose a
  stop action on `BrowserPaneRef` (line 61) if the control lives in `LeafPane`.
- `src/components/workspace-panes/BrowserPane/BrowserPane.module.css` — indicator styles.
- `src/store/app-store.ts` — recording-state slice plus its actions.
- `src/App.tsx` — feed recording start/stop events from `onRecordingCommand` into the store.
