#!/bin/bash
#
# A stand-in for a real agent CLI, for tests that need *sessions* rather than
# an agent.
#
# Manor does not learn about a session by watching a process: an agent CLI
# reports its own lifecycle over the hook endpoint (electron/agent-hooks.ts),
# and hook-relay-effects.ts turns those events into the AgentInfo rows that
# GET /agents — and therefore the phone client — renders. So the cheapest honest
# fake is a script that speaks the same hook protocol against $MANOR_HOOK_PORT,
# using the $MANOR_PANE_ID the pty layer already put in its environment.
#
# What it gives a test that a real agent could not: deterministic scrollback, a
# session that parks in requires_input on purpose, and no network, API key, or
# model latency.
#
# The strings it prints are asserted on from helpers/fake-agent.ts.

set -u

session="e2e-$$"

hook() {
  [ -n "${MANOR_HOOK_PORT:-}" ] || return 0
  [ -n "${MANOR_PANE_ID:-}" ] || return 0
  curl -sS -o /dev/null \
    "http://127.0.0.1:${MANOR_HOOK_PORT}/hook/event?paneId=${MANOR_PANE_ID}&sessionId=${session}&kind=claude&eventType=$1${2:+&notificationKind=$2}" \
    || true
}

# The window title becomes the agent name (see app-lifecycle.ts), which is what
# the session list on the phone shows.
printf '\033]0;%s\007' "${1:-fake agent}"

# Read like an agent TUI does, not like a shell script. Manor sends input as
# the harness interrupt (ESC) followed by the text and a bare CR, which is what
# a raw-mode TUI expects. Left in canonical mode the line discipline holds all
# of that in its buffer waiting for a newline that never comes, so the fake
# agent would sit there while the app believed it had typed.
stty -icanon -echo min 1 time 0 2>/dev/null || true

# Coloured on purpose: the phone client renders ANSI rather than stripping it,
# and a fake agent whose output is plain text would not exercise that.
green=$'\033[32m'
yellow=$'\033[33m'
reset=$'\033[0m'

hook SessionStart
printf '%sfake-agent ready%s\n' "$green" "$reset"
[ $# -gt 0 ] && printf 'prompt: %s\n' "$1"

# Park in requires_input: the state the remote surface exists to report.
hook Notification permission_prompt
printf '%swaiting for input%s\n' "$yellow" "$reset"

line=""
while IFS= read -r -n 1 char; do
  # An empty read is a newline; bash strips its own delimiter.
  if [ -z "$char" ] || [ "$char" = $'\r' ]; then
    [ -n "$line" ] || continue
    hook UserPromptSubmit
    printf 'received: %s\n' "$line"
    # A long reply on demand, so a test can check what a full screen of output
    # does to the reader's scroll position.
    if [ "$line" = "spam" ]; then
      for i in $(seq 1 200); do printf 'line %s\n' "$i"; done
    fi
    # "hush" ends the turn and stays there. Every other message re-arms the
    # permission prompt, so a test that needs the *responded* state — the one
    # the green dot pulses for — has no other way to reach it.
    if [ "$line" = "hush" ]; then
      line=""
      hook Stop
      continue
    fi
    line=""
    hook Stop
    hook Notification permission_prompt
    continue
  fi
  # Control bytes (the interrupt is ESC) are not part of the message.
  case "$char" in
    [[:cntrl:]]) continue ;;
  esac
  line="$line$char"
done

hook SessionEnd
