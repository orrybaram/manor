/**
 * Webview CLI script — writes manor-webview shell command to disk.
 * Follows the same pattern as ensureHookScript() in agent-hooks.ts.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const WEBVIEW_CLI_PATH = path.join(
  process.env.HOME || "/tmp",
  ".manor",
  "bin",
  "manor-webview",
);

export const WEBVIEW_CLI_SCRIPT = `#!/bin/bash
# manor-webview — CLI wrapper for the Manor webview HTTP API.
# Lets any CLI agent inspect and interact with browser panes in Manor.

PORT_FILE="$HOME/.manor/webview-server-port"

# ── helpers ──────────────────────────────────────────────────────────────────

usage() {
  cat <<'EOF'
Usage: manor-webview <command> [paneId] [options]

Commands:
  list                          List all open webview panes
  screenshot [paneId]           Capture a screenshot (base64 PNG to stdout)
  dom        [paneId]           Print simplified DOM HTML to stdout
  exec-js    [paneId] <code>    Execute JavaScript and print result
  click      [paneId] --selector <s>   Click element matching CSS selector
  click      [paneId] --x <n> --y <n>  Click at coordinates
  type       [paneId] --selector <s> --text <t>  Type text into element
  navigate   [paneId] <url>     Navigate to URL
  console-logs [paneId]         Print console log entries
  url        [paneId]           Print current URL

If paneId is omitted, auto-resolves when exactly one webview is open.
EOF
}

die() {
  echo "$1" >&2
  exit 1
}

get_port() {
  if [ ! -f "$PORT_FILE" ]; then
    die "Manor is not running or has no webview server active"
  fi
  cat "$PORT_FILE"
}

# Run a curl request; on connection failure print error and exit 1
# Usage: do_curl <method> <path> [body]
do_curl() {
  local method="$1"
  local url_path="$2"
  local body="$3"
  local port
  port=$(get_port)

  local curl_args=(-s -o /tmp/manor_webview_resp -w "%{http_code}"
    -X "$method"
    --connect-timeout 5 --max-time 30
    "http://127.0.0.1:\${port}\${url_path}")

  if [ -n "$body" ]; then
    curl_args+=(-H "Content-Type: application/json" -d "$body")
  fi

  local http_code
  http_code=$(curl "\${curl_args[@]}") || die "Cannot connect to Manor webview server"

  local resp
  resp=$(cat /tmp/manor_webview_resp 2>/dev/null)

  if [ "$http_code" -ge 400 ] 2>/dev/null; then
    # Try to extract error field from JSON
    local err_msg
    err_msg=$(echo "$resp" | grep -oE '"error"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | grep -oE '"[^"]*"$' | tr -d '"')
    if [ -n "$err_msg" ]; then
      die "$err_msg"
    else
      die "HTTP $http_code: $resp"
    fi
  fi

  echo "$resp"
}

# Auto-resolve paneId: if exactly one webview exists, return its paneId
auto_resolve_pane() {
  local list_resp
  list_resp=$(do_curl GET /webviews)

  # Count entries by counting "paneId" occurrences
  local count
  count=$(echo "$list_resp" | grep -o '"paneId"' | wc -l | tr -d ' ')

  if [ "$count" -eq 0 ]; then
    echo "No webview panes are open." >&2
    die "Available panes: none"
  fi

  if [ "$count" -gt 1 ]; then
    echo "Multiple webview panes are open. Specify a paneId:" >&2
    echo "$list_resp" | grep -oE '"paneId"[[:space:]]*:[[:space:]]*"[^"]*"' | grep -oE '"[^"]*"$' | tr -d '"' | while read -r pid; do
      echo "  $pid" >&2
    done
    exit 1
  fi

  # Exactly one — extract it
  echo "$list_resp" | grep -oE '"paneId"[[:space:]]*:[[:space:]]*"[^"]*"' | grep -oE '"[^"]*"$' | tr -d '"'
}

# Format the /webviews list output
format_list() {
  local resp="$1"
  # Simple extraction: print each paneId + url + title
  echo "$resp" | python3 -c "
import sys, json
data = json.load(sys.stdin)
if not data:
    print('No webview panes open.')
else:
    for item in data:
        print(f\\"paneId: {item['paneId']}\\")
        print(f\\"  url:   {item['url']}\\")
        print(f\\"  title: {item['title']}\\")
        print()
" 2>/dev/null || echo "$resp"
}

# Format console-logs output
format_console_logs() {
  local resp="$1"
  echo "$resp" | python3 -c "
import sys, json
data = json.load(sys.stdin)
if not data:
    print('No console log entries.')
else:
    for entry in data:
        ts = entry.get('timestamp', '')
        level = entry.get('level', 'log').upper()
        msg = entry.get('message', '')
        print(f\\"[{ts}] [{level}] {msg}\\")
" 2>/dev/null || echo "$resp"
}

# ── argument parsing ──────────────────────────────────────────────────────────

if [ $# -eq 0 ] || [ "$1" = "--help" ] || [ "$1" = "-h" ]; then
  usage
  exit 0
fi

COMMAND="$1"
shift

case "$COMMAND" in

  list)
    resp=$(do_curl GET /webviews)
    format_list "$resp"
    ;;

  screenshot)
    # screenshot [paneId]
    if [ $# -ge 1 ] && [[ "$1" != --* ]]; then
      PANE_ID="$1"; shift
    else
      PANE_ID=$(auto_resolve_pane)
    fi
    resp=$(do_curl POST "/webview/\${PANE_ID}/screenshot")
    # Extract base64 image field
    echo "$resp" | grep -oE '"image"[[:space:]]*:[[:space:]]*"[^"]*"' | grep -oE '"[^"]*"$' | tr -d '"'
    ;;

  dom)
    # dom [paneId]
    if [ $# -ge 1 ] && [[ "$1" != --* ]]; then
      PANE_ID="$1"; shift
    else
      PANE_ID=$(auto_resolve_pane)
    fi
    resp=$(do_curl POST "/webview/\${PANE_ID}/dom")
    # Extract html field value (may be long — use python3 for reliability)
    echo "$resp" | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(data.get('html', ''))
" 2>/dev/null || echo "$resp"
    ;;

  exec-js)
    # exec-js [paneId] <code>
    # If 2 positional args: first is paneId, second is code
    # If 1 positional arg: it's the code, auto-resolve paneId
    if [ $# -ge 2 ] && [[ "$2" != --* ]]; then
      PANE_ID="$1"; shift
      CODE="$1"; shift
    elif [ $# -ge 1 ] && [[ "$1" != --* ]]; then
      CODE="$1"; shift
      PANE_ID=$(auto_resolve_pane)
    else
      die "Usage: manor-webview exec-js [paneId] <code>"
    fi
    BODY=$(python3 -c "import json,sys; print(json.dumps({'code': sys.argv[1]}))" "$CODE")
    resp=$(do_curl POST "/webview/\${PANE_ID}/execute-js" "$BODY")
    echo "$resp" | python3 -c "
import sys, json
data = json.load(sys.stdin)
result = data.get('result')
if result is None:
    print('null')
elif isinstance(result, str):
    print(result)
else:
    print(json.dumps(result, indent=2))
" 2>/dev/null || echo "$resp"
    ;;

  click)
    # click [paneId] --selector <s>
    # click [paneId] --x <n> --y <n>
    # Peek: if first arg doesn't start with --, treat as paneId
    if [ $# -ge 1 ] && [[ "$1" != --* ]]; then
      PANE_ID="$1"; shift
    else
      PANE_ID=$(auto_resolve_pane)
    fi

    SELECTOR=""
    CLICK_X=""
    CLICK_Y=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --selector) SELECTOR="$2"; shift 2 ;;
        --x)        CLICK_X="$2"; shift 2 ;;
        --y)        CLICK_Y="$2"; shift 2 ;;
        *) die "Unknown option: $1" ;;
      esac
    done

    if [ -n "$SELECTOR" ]; then
      BODY=$(python3 -c "import json,sys; print(json.dumps({'selector': sys.argv[1]}))" "$SELECTOR")
    elif [ -n "$CLICK_X" ] && [ -n "$CLICK_Y" ]; then
      BODY=$(python3 -c "import json,sys; print(json.dumps({'x': int(sys.argv[1]), 'y': int(sys.argv[2])}))" "$CLICK_X" "$CLICK_Y")
    else
      die "Usage: manor-webview click [paneId] --selector <s>  OR  --x <n> --y <n>"
    fi

    do_curl POST "/webview/\${PANE_ID}/click" "$BODY" > /dev/null
    echo "ok"
    ;;

  type)
    # type [paneId] --selector <s> --text <t>
    if [ $# -ge 1 ] && [[ "$1" != --* ]]; then
      PANE_ID="$1"; shift
    else
      PANE_ID=$(auto_resolve_pane)
    fi

    SELECTOR=""
    TEXT=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --selector) SELECTOR="$2"; shift 2 ;;
        --text)     TEXT="$2"; shift 2 ;;
        *) die "Unknown option: $1" ;;
      esac
    done

    if [ -z "$TEXT" ]; then
      die "Usage: manor-webview type [paneId] --selector <s> --text <t>"
    fi

    if [ -n "$SELECTOR" ]; then
      BODY=$(python3 -c "import json,sys; print(json.dumps({'selector': sys.argv[1], 'text': sys.argv[2]}))" "$SELECTOR" "$TEXT")
    else
      BODY=$(python3 -c "import json,sys; print(json.dumps({'text': sys.argv[1]}))" "$TEXT")
    fi

    do_curl POST "/webview/\${PANE_ID}/type" "$BODY" > /dev/null
    echo "ok"
    ;;

  navigate)
    # navigate [paneId] <url>
    if [ $# -ge 2 ] && [[ "$2" != --* ]]; then
      PANE_ID="$1"; shift
      NAV_URL="$1"; shift
    elif [ $# -ge 1 ] && [[ "$1" != --* ]]; then
      NAV_URL="$1"; shift
      PANE_ID=$(auto_resolve_pane)
    else
      die "Usage: manor-webview navigate [paneId] <url>"
    fi

    BODY=$(python3 -c "import json,sys; print(json.dumps({'url': sys.argv[1]}))" "$NAV_URL")
    do_curl POST "/webview/\${PANE_ID}/navigate" "$BODY" > /dev/null
    echo "ok"
    ;;

  console-logs)
    # console-logs [paneId]
    if [ $# -ge 1 ] && [[ "$1" != --* ]]; then
      PANE_ID="$1"; shift
    else
      PANE_ID=$(auto_resolve_pane)
    fi
    resp=$(do_curl GET "/webview/\${PANE_ID}/console-logs")
    format_console_logs "$resp"
    ;;

  url)
    # url [paneId]
    if [ $# -ge 1 ] && [[ "$1" != --* ]]; then
      PANE_ID="$1"; shift
    else
      PANE_ID=$(auto_resolve_pane)
    fi
    resp=$(do_curl GET "/webview/\${PANE_ID}/url")
    echo "$resp" | grep -oE '"url"[[:space:]]*:[[:space:]]*"[^"]*"' | grep -oE '"[^"]*"$' | tr -d '"'
    ;;

  *)
    echo "Unknown command: $COMMAND" >&2
    echo "" >&2
    usage
    exit 1
    ;;

esac
`;

/** Ensure the manor-webview CLI script exists on disk with execute permissions */
export function ensureWebviewCli(): void {
  const dir = path.dirname(WEBVIEW_CLI_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(WEBVIEW_CLI_PATH, WEBVIEW_CLI_SCRIPT, { mode: 0o755 });
}
