#!/bin/bash
#
# A stand-in for a Codex, pi or opencode session, for the desk chat
# (tests/e2e/agent-kind-chats.spec.ts).
#
# It writes no transcript of its own: the test puts one where that kind keeps
# its sessions (a Codex rollout, a pi session file, or an opencode.db and the
# `<db>#<session>` locator) and hands its path in. This script only does what
# that kind's Manor hook does from inside the pane: it reports a session
# start, a prompt and a stop to Manor's hook listener with `kind=<kind>` and
# the transcript as `transcriptPath`, so the pane gets an Agent of that kind
# whose chat reads the file. Then it holds the pane until it reads "exit".
#
# The hook target is found as the opencode plugin finds it
# (electron/opencode-plugin.ts): the port file (port, then token), else
# MANOR_HOOK_PORT / MANOR_HOOK_TOKEN.
#
# Usage: fake-agent-kind.sh <codex|pi|opencode> <session id> <transcript path> [title]

set -u

kind="$1"
session="$2"
transcript="$3"
title="${4:-fake ${kind} agent}"

port=""
token=""
port_file="${MANOR_HOOK_PORT_FILE:-$HOME/.manor/hook-port}"
if [ -r "$port_file" ]; then
  port=$(sed -n 1p "$port_file" | tr -d '[:space:]')
  token=$(sed -n 2p "$port_file" | tr -d '[:space:]')
fi
if [ -z "$port" ]; then
  port="${MANOR_HOOK_PORT:-}"
  token="${MANOR_HOOK_TOKEN:-}"
fi

hook() {
  [ -n "$port" ] || { echo "fake-agent-kind: no hook port" >&2; return 0; }
  [ -n "${MANOR_PANE_ID:-}" ] || { echo "fake-agent-kind: no MANOR_PANE_ID" >&2; return 0; }
  # -G with --data-urlencode: the transcript path is a file path (and, for
  # opencode, holds a `#`), not a URL-safe token.
  curl -sS -o /dev/null -G "http://127.0.0.1:${port}/hook/event" \
    -H "x-manor-hook-token: ${token}" \
    --data-urlencode "paneId=${MANOR_PANE_ID}" \
    --data-urlencode "sessionId=${session}" \
    --data-urlencode "kind=${kind}" \
    --data-urlencode "eventType=$1" \
    --data-urlencode "transcriptPath=${transcript}" \
    || true
}

printf '\033]0;%s\007' "$title"

hook SessionStart
hook UserPromptSubmit
hook Stop
printf '\033[32mfake %s agent ready\033[0m\n' "$kind"

while IFS= read -r line; do
  [ "$line" = "exit" ] && break
done

hook SessionEnd
