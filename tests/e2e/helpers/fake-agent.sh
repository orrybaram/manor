#!/bin/bash
#
# A stand-in for a real agent CLI, for tests that need *sessions* rather than
# an agent.
#
# Manor does not learn about a session by watching a process: an agent CLI
# reports its own lifecycle over the hook endpoint (electron/agent-hook-events.ts),
# and the Status reconciler (ADR-184, electron/agent-status/) turns those hook
# events into the AgentInfo rows that GET /agents — and therefore the phone
# client — renders. So the cheapest honest fake is a script that speaks the
# same hook protocol against $MANOR_HOOK_PORT, using the $MANOR_PANE_ID the pty
# layer already put in its environment.
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

# The window title becomes the agent name (see app-lifecycle.ts's
# `handleAgentStreamEvent`), which is what the session list on the phone
# shows. A real agent CLI re-sets its title on every turn, so the fake does
# the same.
title="${1:-fake agent}"
retitle() { printf '\033]0;%s\007' "$title"; }
retitle

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
    retitle
    printf 'received: %s\n' "$line"
    # A long reply on demand, so a test can check what a full screen of output
    # does to the reader's scroll position.
    if [ "$line" = "spam" ]; then
      for i in $(seq 1 200); do printf 'line %s\n' "$i"; done
    fi
    # Two identical rows, wider than any phone — ADR-177's grid-fidelity
    # fixture. Wide enough that a naive wrapping renderer would break each
    # into several visual rows; a real terminal (and a client that renders one
    # without reflowing) keeps each as one line regardless of how it wraps in
    # transit. See `FAKE_AGENT_RULER_ROW` in fake-agent.ts for the exact text.
    if [ "$line" = "ruler" ]; then
      ruler=$(printf '#%.0s' $(seq 1 120))
      printf '%s\n' "$ruler"
      printf '%s\n' "$ruler"
    fi
    # "hush" ends the turn and stays there. Every other message re-arms the
    # permission prompt, so a test that needs the *responded* state — the one
    # the green dot pulses for — has no other way to reach it.
    if [ "$line" = "hush" ]; then
      line=""
      hook Stop
      continue
    fi
    # "slow-hush" is "hush" with a pause before the Stop hook, so a test can
    # observe the *thinking* status (raised by the UserPromptSubmit hook
    # above) before it turns into responded — otherwise the two hooks land too
    # close together to poll for the one in between.
    if [ "$line" = "slow-hush" ]; then
      sleep 1
      line=""
      hook Stop
      continue
    fi
    # "exit" ends the session cleanly, the way a real agent CLI would when the
    # user quits it: SessionEnd fires and the process exits, rather than a test
    # having to kill the pty and go through the daemon's liveness fallback.
    if [ "$line" = "exit" ]; then
      break
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
