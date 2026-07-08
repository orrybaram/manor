# ADR-149 smoke test

Nothing has exercised the full `MCP → HTTP → IPC → zustand` round-trip in a live
app. The unit tests stub `webContents.send` and synthesize the reply, so they
prove the wiring's *shape*, not that a real renderer answers.

## Before you start

`manorHomeDir()` is unconditionally `~/.manor` (`electron/paths.ts:32`) — it is
**not** namespaced by dev/prod. A dev instance writes the same
`~/.manor/layout.json` and `~/.manor/webview-server-port` as the packaged app.

**Quit the packaged Manor first.** Otherwise the dev build overwrites your live
pane layout, and `webview-server-port` starts pointing your MCP tools at
whichever instance wrote last.

Then:

```
pnpm dev
```

Open a Claude Code session with the `manor` MCP server inside a Manor terminal
pane, and run the following in order.

## The script

| # | Call | Expect |
|---|---|---|
| 1 | `list_panes` | Indented tree. One tab, one pane, marked `[active]` / `[focused]`. Note the `paneId`. |
| 2 | `new_browser` with `url: "https://example.com"` | Returns `tabId` + `paneId`. A browser tab opens and loads example.com. |
| 3 | `screenshot_webview` with `paneId` from step 2 | Renders example.com. **If it 404s, retry once** — the `<webview>` registers its `webContentsId` a tick after the store updates. |
| 4 | `split_pane` `direction: "horizontal"`, `contentType: "terminal"` | New terminal pane appears **to the right**. Returns its `paneId`. |
| 5 | `split_pane` `direction: "vertical"` | New pane appears **below** the focused one. |
| 6 | `split_pane` `direction: "horizontal"`, `position: "first"` | New pane appears **to the left**. |
| 7 | `split_pane` `direction: "horizontal"`, `contentType: "browser"`, `url: "https://example.com"` | Browser pane opens **with the URL bar populated**. This is the ticket-2 bugfix — before ADR-149 the URL bar was empty. |
| 8 | `new_terminal` with `command: "echo hi"` | New tab; `hi` printed in it. |
| 9 | `focus_pane` with a `paneId` from step 4 | Focus ring moves to that pane. |
| 10 | `close_pane` with the same `paneId` | Pane disappears; siblings reflow. |
| 11 | `list_panes` again | Tree reflects every mutation above. |

## Error paths worth one poke each

| Call | Expect |
|---|---|
| `split_pane` with `paneId: "nope"` | An error, **not** silent success. (`splitPaneAt` no-ops on unknown panes; the ticket-3 handler throws before calling it.) |
| `split_pane` with `direction: "sideways"` | Rejected at the schema or with a 400. |
| `new_terminal` with `workspacePath: "/nonexistent"` | An error, not a tab in the wrong workspace. |

## What to record

Append an `## Outcome` section to `index.md` and flip
`status: proposed` → `status: accepted` if it all passes.

**Watch step 3 specifically.** The ADR assumes the mount race is *occasional*.
If `screenshot_webview` fails on the **first** call every single time, the ADR's
risk assessment is wrong and `new_browser` should await pane registration rather
than telling the agent to retry. Do not paper over it with a `sleep` in the tool
— that hides the race instead of fixing it. Say so and we'll reopen.

## Known-red baseline (not caused by ADR-149)

Do not be alarmed by these; they predate this work and are unrelated:

- `pnpm exec vitest run` → 3 failures: 2 × `tasks:markSeen`
  (`electron/__tests__/tasks-unseen-source-of-truth.test.ts`), 1 × `closePaneById`
  (`src/store/__tests__/app-store-close-pane-abandon.test.ts`).
  The `closePaneById` one is a **stale test**, not a bug: it asserts
  `abandonForPane("pane-1")` but the real call passes two args,
  `(paneId, title | null)`.
- `pnpm exec tsc --noEmit -p tsconfig.electron.json` → 31 errors, three of which
  are `'d.detail' is possibly 'undefined'` in `control-server.ts`, inherited from
  ADR-148.
- `pnpm exec tsc --noEmit -p tsconfig.json` → 6 errors, all in two test files.
