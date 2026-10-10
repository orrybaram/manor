---
title: E2E spec for the phone chat view
status: done
priority: medium
assignee: opus
blocked_by: [5]
---

# E2E spec for the phone chat view

Follow-up to ticket 5. The phone E2E specs drive a real app through `tests/e2e/helpers/fake-agent.sh`. That fake agent writes no transcript and reports no `transcriptPath`, so nothing exercises the chat view end to end.

## Fake agent: transcript mode, opt-in

- Add a transcript mode that is **opt-in**: for example an env var, or a separate `fake-agent-transcript` script, whichever fits how specs launch the fake agent today.
  - Turning it on for every fake agent would flip every phone pane to chat by default. That would break the existing phone specs that type into xterm.
- In transcript mode the fake agent:
  1. Writes a JSONL transcript in Claude's shape to a temp file:
     - a user prompt
     - assistant text
     - an `AskUserQuestion` `tool_use` with 3 single-select options
  2. Reports `transcript_path` through the same hook path the fake agent already uses, so `AgentInfo.transcriptPath` gets set.
  3. Reads stdin. When it receives the bytes `encodePickerAnswer` produces for option 3 (Down, Down, Enter), it appends the matching `tool_result` line ("…"="<label>").
     - It also records each raw chunk it receives to a file the spec can read. This is the observable outcome, because `chat.*` calls are deliberately not audited.
  4. When it receives a typed line followed by `\r` (a composer send), appends it as a user line. This exercises `chat.send` end to end.

## Spec

`tests/e2e/phone-chat.spec.ts` uses the existing phone-viewport fixtures. Find how the ADR-181 phone specs set up the viewport and the paired browser.

1. Start a fake agent in transcript mode.
2. Open its pane at phone width and check that the Chat | Terminal toggle shows, with Chat selected.
3. Check that the assistant text and the question card render.
4. Tap option 3. Check that the card collapses to an answered summary, and that the fake agent's input log shows Down, Down, Enter.
5. Type in the composer and Send. Check that the user bubble appears.
6. Toggle to Terminal. Check that xterm is visible and that toggling back to Chat keeps the history.

Use `data-testid`s where ticket 5's components lack stable selectors, and add them there.

**Do not run Playwright.** The orchestrator runs it. Run `pnpm typecheck` and `npx eslint tests/e2e`.

## Files to touch
- `tests/e2e/helpers/fake-agent*` — the transcript mode
- `tests/e2e/phone-chat.spec.ts` — new
- `src/components/phone/ChatPane/*` — `data-testid`s only, if needed
