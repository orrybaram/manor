---
title: Advertise the manor CLI to Claude Code at SessionStart
status: done
priority: medium
assignee: sonnet
blocked_by: [4]
---

# Advertise the `manor` CLI to Claude Code at SessionStart

Agents only find the CLI if something tells them. Claude Code adds a SessionStart hook's stdout to the session context, so the existing hook can carry a one-line hint at zero cost.

In `electron/scripts/agent-hook.js` `main()`, after the hook event has been forwarded (or even if forwarding fails), when `eventType === "SessionStart"` and `kind === "claude"` and `MANOR_PANE_ID` is set, write exactly one JSON line to stdout:

```json
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"This terminal runs inside Manor. The `manor` CLI is on PATH: run `manor --help` for commands that manage projects, workspaces, panes, agents, and browser panes. Prefer it over the mcp__manor__* tools; they do the same thing but load a large tool roster into context."}}
```

Rules: `stdout` comes from `opts.stdout || process.stdout` so tests capture it. Never print for other events or other agent kinds (their hook stdout semantics differ). Nothing else about the hook changes; it must still exit 0 in every path.

## Tests (`electron/__tests__/agent-hook-script.test.ts`)
- SessionStart + claude → stdout has exactly one line, parses as JSON, `hookSpecificOutput.hookEventName === "SessionStart"`, `additionalContext` mentions `manor --help`.
- SessionStart + `MANOR_AGENT_KIND=codex` → stdout empty.
- `UserPromptSubmit` + claude → stdout empty.
- SessionStart with the fetch rejecting → stdout still has the hint, stderr has the request-failed line.

## Files to touch
- `electron/scripts/agent-hook.js`
- `electron/__tests__/agent-hook-script.test.ts`
