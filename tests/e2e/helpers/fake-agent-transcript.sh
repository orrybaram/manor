#!/bin/bash
#
# fake-agent.sh's transcript-writing sibling, for the phone chat view
# (ADR-215, tests/e2e/phone-chat.spec.ts).
#
# A separate script rather than a mode of fake-agent.sh on purpose: a pane
# whose agent reports a transcript flips to the chat view on a phone by
# default, and the phone specs that type into xterm must keep getting a
# terminal. Nothing gets a transcript without asking for this script.
#
# What it does, in Claude Code's shapes (electron/chat-mirror/transcript.ts):
#
# 1. Writes a JSONL transcript: a user prompt, an assistant reply, and an
#    AskUserQuestion tool_use with three single-select options that has no
#    tool_result yet — Claude waiting on its picker.
# 2. Reports it as `transcriptPath` on every hook, the way agent-hook.js
#    forwards Claude's `transcript_path`, so the session's Agent gets it.
# 3. Reads its tty raw. A line ending in CR is either picker keys — Down×i
#    then Enter (electron/chat-mirror/picker-keys.ts) — which appends the
#    question's tool_result for option i, or typed text (`chat.send`), which
#    appends a user line and an assistant echo.
# 4. Appends every byte it reads, raw, to the input log. `chat.*` calls are
#    deliberately not audited, so the log is how a test sees what was typed.
#
# Usage: fake-agent-transcript.sh <transcript.jsonl> <input.log> [title]
#
# The strings it writes are asserted on from helpers/fake-agent.ts.

set -u

transcript="$1"
input_log="$2"
title="${3:-fake chat agent}"
session="e2e-chat-$$"

hook() {
  # On a remote host (tests/e2e/remote-host.spec.ts) the daemon's hook
  # listener wants a token that a bare curl doesn't send (its MANOR_HOOK_PORT
  # is set, but to that listener). Do what a real agent does there and run the
  # payload through Manor's own hook script, which resolves the target and its
  # token (resolveHookTarget). Locally, with no such script, curl as before.
  notify="$HOME/.manor/hooks/notify.sh"
  if [ -n "${MANOR_HOOK_PORT_FILE:-}" ] && [ -x "$notify" ]; then
    printf '{"hook_event_name":"%s","session_id":"%s","transcript_path":"%s"%s}' \
      "$1" "$session" "$(json_escape "$transcript")" \
      "${2:+,\"notification\":{\"type\":\"$2\"}}" \
      | "$notify" >/dev/null 2>&1 || true
    return 0
  fi
  [ -n "${MANOR_HOOK_PORT:-}" ] || return 0
  [ -n "${MANOR_PANE_ID:-}" ] || return 0
  # -G with --data-urlencode: a GET whose query is built and escaped by curl,
  # because a transcript path is a file path, not a URL-safe token.
  curl -sS -o /dev/null -G "http://127.0.0.1:${MANOR_HOOK_PORT}/hook/event" \
    --data-urlencode "paneId=${MANOR_PANE_ID}" \
    --data-urlencode "sessionId=${session}" \
    --data-urlencode "kind=claude" \
    --data-urlencode "eventType=$1" \
    --data-urlencode "transcriptPath=${transcript}" \
    ${2:+--data-urlencode "notificationKind=$2"} \
    || true
}

retitle() { printf '\033]0;%s\007' "$title"; }
retitle

# Raw input, and -icrnl so Enter arrives as the CR a picker key sequence ends
# with rather than being turned into a newline by the line discipline.
saved_tty=$(stty -g 2>/dev/null || true)
restore_tty() { [ -n "$saved_tty" ] && stty "$saved_tty" 2>/dev/null; }
trap restore_tty EXIT
stty -icanon -echo -icrnl min 1 time 0 2>/dev/null || true

now() { date -u +%Y-%m-%dT%H:%M:%S.000Z; }

# JSON string contents: backslash and quote escaped. Input is stripped of
# control bytes before it gets here, so nothing else needs escaping.
json_escape() {
  # sed rather than ${s//…}: macOS's /bin/bash is 3.2, whose pattern
  # substitution mangles backslashes.
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

append() { printf '%s\n' "$1" >> "$transcript"; }

user_line() { # uuid text
  append "{\"type\":\"user\",\"uuid\":\"$1\",\"timestamp\":\"$(now)\",\"message\":{\"role\":\"user\",\"content\":\"$(json_escape "$2")\"}}"
}

assistant_text() { # uuid text
  append "{\"type\":\"assistant\",\"uuid\":\"$1\",\"timestamp\":\"$(now)\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"$(json_escape "$2")\"}]}}"
}

question_id="toolu_fake_question"
question_text="Which option should the fake agent take?"
labels=("Option 1" "Option 2" "Option 3")

ask_question() {
  append "{\"type\":\"assistant\",\"uuid\":\"a-question\",\"timestamp\":\"$(now)\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"${question_id}\",\"name\":\"AskUserQuestion\",\"input\":{\"questions\":[{\"question\":\"${question_text}\",\"header\":\"Choice\",\"multiSelect\":false,\"options\":[{\"label\":\"${labels[0]}\",\"description\":\"The first\"},{\"label\":\"${labels[1]}\",\"description\":\"The second\"},{\"label\":\"${labels[2]}\",\"description\":\"The third\"}]}]}}]}}"
}

answer_question() { # label
  append "{\"type\":\"user\",\"uuid\":\"u-answer\",\"timestamp\":\"$(now)\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"${question_id}\",\"content\":\"User has answered your questions: \\\"${question_text}\\\"=\\\"$1\\\". You can now continue with the user's answers in mind.\"}]}}"
}

mkdir -p "$(dirname "$transcript")" "$(dirname "$input_log")"
: > "$transcript"
: > "$input_log"

# The transcript exists before the first hook names it, as with Claude.
user_line "u-prompt" "Help me pick an option"
assistant_text "a-reply" "Here are three ways to go."
ask_question

hook SessionStart
printf '\033[32mfake-agent ready\033[0m\n'

# Claude waiting on its picker.
hook Notification permission_prompt
printf '\033[33mwaiting for an answer\033[0m\n'

answered=0
turn=0
buf=""
down=$'\033[B'
while IFS= read -r -n 1 -d '' char; do
  printf '%s' "$char" >> "$input_log"
  # bash's `read -n` applies its own tty mode, which can map CR back to LF
  # despite the stty above, so either byte is Enter.
  if [ "$char" != $'\r' ] && [ "$char" != $'\n' ]; then
    buf="$buf$char"
    continue
  fi

  line="$buf"
  buf=""

  # Picker keys: count the Downs. Anything else in the line is noise.
  without_down="${line//"$down"/}"
  downs=$(( (${#line} - ${#without_down}) / ${#down} ))
  if [ "$answered" -eq 0 ] && [ "$downs" -lt "${#labels[@]}" ] && [[ "$line" == *$'\033'* || -z "$line" ]]; then
    answered=1
    label="${labels[$downs]}"
    answer_question "$label"
    printf 'answered: %s\n' "$label"
    hook PostToolUse
    assistant_text "a-after-answer" "Going with ${label}."
    hook Stop
    continue
  fi

  # A typed line (`chat.send`): printable text only.
  text=$(printf '%s' "$line" | LC_ALL=C tr -d '\000-\037\177')
  [ -n "$text" ] || continue
  turn=$((turn + 1))
  hook UserPromptSubmit
  retitle
  user_line "u-sent-$turn" "$text"
  printf 'received: %s\n' "$text"
  assistant_text "a-sent-$turn" "received: $text"
  hook Stop
  [ "$text" = "exit" ] && break
done

hook SessionEnd
