---
title: MCP tools — start_recording, stop_recording, list_recordings
status: done
priority: high
assignee: sonnet
blocked_by: [3]
---

# MCP recording tools

Add the three tools to `electron/mcp/tools-webview.ts`. They join the existing `tools` array and
`handlers` object, so they register automatically via `webviewModule` — no change needed in
`electron/mcp-webview-server.ts`.

## Tool definitions

**`start_recording`** — `{ paneId?, path?, maxDurationSec?, keyframeIntervalSec? }`

Description must state plainly: records to a `.webm` file on disk, returns immediately, and
**must be paired with `stop_recording`**. Mention that `.webm` does not open in QuickTime but plays
in Chrome, VS Code, and IINA — the agent will be handing this path to a human. Note the default
`maxDurationSec` of 120 so the caller knows recording is not open-ended.

**`stop_recording`** — `{ recordingId? }`

Describe the return as the file path plus sampled keyframe images. Say that the video itself is not
returned inline — this is what stops a model from asking for the video contents.

**`list_recordings`** — no args. Active recordings and elapsed time.

`paneId` descriptions copy the existing wording used throughout the file: "Pane ID. Omit if only one
webview is open."

## Handlers

- `start_recording` — `resolvePaneId` (line 34), `POST /webview/:id/record/start`, return text with
  the `recordingId` and path. Append the server's `warning` when present.
- `stop_recording` — `POST /webview/:id/record/stop`. Return a mixed content array: a text block
  with path, duration, and size, followed by one `image` block per keyframe
  (`{ type: "image", data, mimeType: "image/png" }`). The `pick_element` handler at line 401 builds
  exactly this text-plus-images shape — follow it.
- `list_recordings` — `GET /recordings`. Return "No active recordings." when empty, matching how
  `get_console_logs` (line 379) handles its empty case.

`stop_recording` without a `recordingId` still needs a pane to address, so resolve the pane the same
way the other handlers do.

## Files to touch

- `electron/mcp/tools-webview.ts` — three `ToolDef` entries and three handlers.
- `electron/__tests__/mcp-webview-server.test.ts` — extend. The `screenshot_webview` handler tests
  at line 1981 show the `Http` stubbing pattern. Cover: start returns the id; stop emits one text
  block plus one image block per keyframe; stop with zero keyframes emits text only;
  `list_recordings` renders the empty case.
- `README.md` — the MCP tool listing, if the existing webview tools are documented there.
