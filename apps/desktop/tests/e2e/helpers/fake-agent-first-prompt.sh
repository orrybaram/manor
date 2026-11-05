#!/bin/bash
#
# A fresh Claude session as it really goes, for the chat's first prompt
# (tests/e2e/desk-chat-first-prompt.spec.ts). Timings taken from a recorded
# Claude Code session:
#
#   SessionStart names the transcript, which doesn't exist yet.
#   Enter: UserPromptSubmit about 60ms later, still no file.
#   100ms after the hook: the file appears, holding only metadata records.
#   100ms after that: the user's prompt.
#   Seconds later: the reply, then Stop.
#
# fake-agent-transcript.sh writes its transcript up front, so it can't show
# what the chat does in between.
#
# Usage: fake-agent-first-prompt.sh <transcript.jsonl> <input.log>

set -u

transcript="$1"
input_log="$2"
session="e2e-first-prompt-$$"

hook() {
  [ -n "${MANOR_HOOK_PORT:-}" ] || return 0
  [ -n "${MANOR_PANE_ID:-}" ] || return 0
  curl -sS -o /dev/null -G "http://127.0.0.1:${MANOR_HOOK_PORT}/hook/event" \
    -H "x-manor-hook-token: ${MANOR_HOOK_TOKEN:-}" \
    --data-urlencode "paneId=${MANOR_PANE_ID}" \
    --data-urlencode "sessionId=${session}" \
    --data-urlencode "kind=claude" \
    --data-urlencode "eventType=$1" \
    --data-urlencode "transcriptPath=${transcript}" \
    || true
}

saved_tty=$(stty -g 2>/dev/null || true)
restore_tty() { [ -n "$saved_tty" ] && stty "$saved_tty" 2>/dev/null; }
trap restore_tty EXIT
stty -icanon -echo -icrnl min 1 time 0 2>/dev/null || true

now() { date -u +%Y-%m-%dT%H:%M:%S.000Z; }
json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
append() { printf '%s\n' "$1" >> "$transcript"; }

mkdir -p "$(dirname "$transcript")" "$(dirname "$input_log")"
rm -f "$transcript"
: > "$input_log"

hook SessionStart
printf 'fake-agent ready\n'

turn=0
buf=""
while IFS= read -r -n 1 -d '' char; do
  printf '%s' "$char" >> "$input_log"
  if [ "$char" != $'\r' ] && [ "$char" != $'\n' ]; then
    buf="$buf$char"
    continue
  fi
  # A prompt arrives as a bracketed paste, not part of the text.
  buf="${buf//$'\033[200~'/}"
  buf="${buf//$'\033[201~'/}"
  text=$(printf '%s' "$buf" | LC_ALL=C tr -d '\000-\037\177')
  buf=""
  [ -n "$text" ] || continue
  turn=$((turn + 1))

  hook UserPromptSubmit
  sleep 0.1
  if [ "$turn" -eq 1 ]; then
    append '{"type":"mode","mode":"default"}'
    append '{"type":"permission-mode","permissionMode":"default"}'
    sleep 0.1
  fi
  append "{\"type\":\"user\",\"uuid\":\"u-$turn\",\"timestamp\":\"$(now)\",\"message\":{\"role\":\"user\",\"content\":\"$(json_escape "$text")\"}}"
  sleep "${FAKE_FIRST_PROMPT_REPLY_DELAY:-2.5}"
  append "{\"type\":\"assistant\",\"uuid\":\"a-$turn\",\"timestamp\":\"$(now)\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"received: $(json_escape "$text")\"}]}}"
  hook Stop
done

hook SessionEnd
