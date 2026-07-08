---
title: End-to-end verification and ADR docs
status: todo
priority: medium
assignee: haiku
blocked_by: [5]
---

# End-to-end verification and docs

## 1. Verify the tool surface

`electron/__tests__/mcp-webview-server.test.ts` already asserts the total tool
count in places. Grep for hardcoded counts (the suite header says "28 existing
MCP tests"; ADR-145 counted 20 tools) and update: **21 → 27**.
(ADR-145's count of 20 predates ADR-148's `get_issue_detail`, which made it 21.)

Add one test asserting `TOOLS` contains the six new names and that every entry in
`TOOLS` has a matching key in `handlers` — a compose-time guard against adding a
`ToolDef` and forgetting the handler (or vice versa). This is cheap and would
have caught the ADR-148 `list_issues` / `?source=` mismatch class of bug.

## 2. Manual smoke

Run `pnpm build` and launch the app, then from a Claude Code session inside the
repo:

```
list_panes                          → shows the current tab + focused pane
new_browser url=https://example.com → returns tabId + paneId
screenshot_webview paneId=<that>    → renders example.com (retry once if it 404s)
split_pane direction=horizontal contentType=terminal → new pane appears to the right
split_pane direction=vertical       → new pane appears below the focused one
new_terminal command="echo hi"      → new tab, "hi" printed
close_pane paneId=<one of them>     → pane disappears
```

Record the outcome in the ADR. If `screenshot_webview` reliably 404s on the first
call rather than occasionally, the mount race is worse than the ADR assumed —
say so; don't paper over it with a sleep in the tool.

## 3. Docs

- `docs/decisions/adr-149-mcp-pane-tools/index.md` — flip `status: proposed` →
  `accepted` **only after** `pnpm typecheck && pnpm build && pnpm test` pass and
  the smoke run above is green. Append a short "Outcome" section noting the
  observed mount-race behavior.
- `README.md` — there is an MCP tools list; extend it with the six new tools.
  Grep for `list_webviews` to find it. If no such list exists, skip.

## Files to touch

- `electron/__tests__/mcp-webview-server.test.ts` — tool count + TOOLS/handlers parity test
- `docs/decisions/adr-149-mcp-pane-tools/index.md` — status + Outcome
- `README.md` — tool list, if present

## Do not

Change implementation code. If verification fails, report the failure — a fix is a
new ticket, not a silent edit here.
