---
title: Ship the orchestrator primer and a fan-out playbook in the SessionStart hint
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Ship the orchestrator primer and a fan-out playbook in the SessionStart hint

ADR-153 ticket-5 specified `src/lib/orchestrator-primer.ts`; it was never
written, and the SessionStart hint is a single sentence pointing at
`manor --help`. An agent told *"use manor to create workspaces and tackle these
tickets"* gets no playbook. See ADR-176 Context §3.

This ticket touches no files that tickets 1 and 2 touch, so it can run
independently of them.

## What to build

### 1. `src/lib/orchestrator-primer.ts` — canonical text

Export `orchestratorPrimer(): string`. Contents, per ADR-153 ticket-5:

- **Manor's model** — projects → workspaces (git worktrees) → tabs/panes
  (terminals) → agents (sessions). One workspace per project is the main one
  ("local").
- **Tool catalog**, split observe / act, naming the `manor` CLI subcommands
  (the CLI is preferred over `mcp__manor__*`; see the existing hint):
  - observe: `list-projects`, `list-workspaces`, `list-issues`,
    `get-issue-detail`, `list-panes`, `list-agents`, `read-session`
  - act: `create-workspace`, `batch-create-workspaces`, `start-agent`,
    `send-to-session`
  - Note `send-to-session` interrupts the target's current turn and may discard
    in-flight work.
- **Fan-out playbook** — the load-bearing addition. One issue per workspace per
  agent is `batch-create-workspaces --issues 1,2,3`; it creates the worktrees
  *and* launches an agent in each in one call. Reach for
  `create-workspace` + `start-agent` only when the work is not issue-backed.
  Pass `--prompt-template` when the default
  (`Work on GitHub issue #{number}: {title}` plus the body) is not what the
  spawned agent should do. Verify afterwards with `list-agents` — a launch that
  reports no pane did not happen.
- **House rules** (behavioural, not enforced): do not fan out more than 4
  agents at once without confirming with the user; confirm before destructive
  actions (removing workspaces, force-pushing, interrupting a `working` agent);
  never instruct a spawned agent to itself orchestrate or spawn further agents.

Keep it tight — this text is a token cost on every session. Aim well under 40
lines of prose.

### 2. Widen the SessionStart hint — `electron/scripts/agent-hook.js:118`

`SESSION_START_HINT.hookSpecificOutput.additionalContext` currently stops at
"run `manor --help`". Append a compact fan-out playbook: `batch-create-workspaces`
as the one-shot issue → workspace → agent path, `--prompt-template` for a custom
prompt, `list-agents` / `read-session` to verify, and the 4-agent soft cap.

`agent-hook.js` is a standalone script Claude Code executes directly — it
**cannot** import from `src/`, so it carries its own string literal. Keep the
existing sentence and its "prefer the CLI over `mcp__manor__*`" guidance intact;
only add to it.

### 3. Keep the two in agreement

Add a unit test (co-locate with the existing `src/lib/__tests__/` suites) that
reads `electron/scripts/agent-hook.js` from disk and asserts the hint mentions
every command the primer names as part of the fan-out path
(`batch-create-workspaces`, `list-agents`). A literal string-equality check is
too brittle — the hint is deliberately a shorter summary — so assert on the
command names, which is the part that actually has to stay true.

## Files to touch
- `src/lib/orchestrator-primer.ts` — NEW. `orchestratorPrimer(): string`.
- `electron/scripts/agent-hook.js` — extend `SESSION_START_HINT` with the fan-out playbook.
- `src/lib/__tests__/orchestrator-primer.test.ts` — NEW. Primer covers the catalog; hint and primer name the same fan-out commands.

## Notes
- `knip` runs in CI (`pnpm knip:ci`) and flags unlisted exports. If nothing
  imports `orchestratorPrimer()` yet, the test importing it is what keeps it
  live; confirm `pnpm knip:ci` passes before committing.

## REQUIRED: Commit your work

When your implementation is complete, you MUST create a git commit. This is not optional.

Run:
  git add -A
  git commit -m "feat(adr-176): Ship the orchestrator primer and a fan-out playbook in the SessionStart hint"

Do not push.
