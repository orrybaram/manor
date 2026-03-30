---
title: CLI tool — manor-webview shell command wrapping the HTTP API
status: done
priority: critical
assignee: sonnet
blocked_by: [2]
---

# CLI tool — manor-webview shell command wrapping the HTTP API

Create a shell script at `~/.manor/bin/manor-webview` that wraps the webview HTTP API. This is the universal interface — any CLI agent that can run shell commands gets webview access.

## Implementation

### New file: `electron/webview-cli-script.ts`

This file exports the CLI script content as a string constant (same pattern as `HOOK_SCRIPT` in `agent-hooks.ts`). The script is a bash script that:

1. Reads the port from `~/.manor/webview-server-port`
2. Parses the subcommand and arguments
3. Makes HTTP requests via `curl`
4. Outputs results to stdout

### CLI interface

```
manor-webview <command> [paneId] [options]
```

If `paneId` is omitted, the CLI first calls `GET /webviews`. If exactly one webview exists, it uses that. If zero or multiple, it prints an error with the list of available panes and exits 1.

**Commands:**

`list` — `GET /webviews`, print as table: `paneId  url  title`

`screenshot [paneId]` — `POST /webview/:id/screenshot`, output the base64 PNG to stdout (agents can read it directly)

`dom [paneId]` — `POST /webview/:id/dom`, output HTML to stdout

`exec-js [paneId] <code>` — `POST /webview/:id/execute-js` with `{"code": "<code>"}`, output result to stdout. The code argument is everything after the paneId (or after exec-js if no paneId).

`click [paneId] --selector <s>` — `POST /webview/:id/click` with `{"selector": "<s>"}`
`click [paneId] --x <n> --y <n>` — `POST /webview/:id/click` with `{"x": n, "y": n}`

`type [paneId] --selector <s> --text <t>` — `POST /webview/:id/type` with `{"selector": "<s>", "text": "<t>"}`

`navigate [paneId] <url>` — `POST /webview/:id/navigate` with `{"url": "<url>"}`

`console-logs [paneId]` — `GET /webview/:id/console-logs`, print formatted entries

`url [paneId]` — `GET /webview/:id/url`, print URL to stdout

`--help` / no args — print usage

### Auto-resolve paneId logic (in bash)

```bash
resolve_pane() {
  if [ -n "$1" ]; then
    echo "$1"
    return 0
  fi
  local webviews=$(curl -s "http://127.0.0.1:${PORT}/webviews")
  local count=$(echo "$webviews" | grep -o '"paneId"' | wc -l)
  if [ "$count" -eq 1 ]; then
    echo "$webviews" | grep -o '"paneId":"[^"]*"' | cut -d'"' -f4
    return 0
  fi
  echo "Multiple webviews open. Specify a paneId:" >&2
  echo "$webviews" >&2
  return 1
}
```

### Error handling

- If port file doesn't exist: print "Manor is not running or has no webview server active" to stderr, exit 1
- If curl fails (connection refused): print "Cannot connect to Manor webview server" to stderr, exit 1
- If HTTP returns error JSON: extract and print the `error` field to stderr, exit 1

### Install function

Export a function `ensureWebviewCli(): void` that writes the script to `~/.manor/bin/manor-webview` with mode `0o755`, creating the directory if needed. Same pattern as `ensureHookScript()`.

## Files to touch
- `electron/webview-cli-script.ts` — new file, exports script content + `ensureWebviewCli()`
