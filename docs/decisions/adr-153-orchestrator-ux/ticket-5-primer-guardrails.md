---
title: Orchestrator primer prompt + soft guardrails, wired into launch
status: todo
priority: high
assignee: sonnet
blocked_by: [2, 3, 4]
---

# Orchestrator primer prompt + soft guardrails, wired into launch

Author the seed prompt that turns a bare agent CLI into the orchestrator, and
wire it into the surface's auto-launch (ticket 4). Blocked by 2/3 so the tool
catalog it documents actually exists, and by 4 so there's a launch to inject into.

## What to build

1. **Primer module** — `src/lib/orchestrator-primer.ts` exporting
   `orchestratorPrimer(): string`. Contents:
   - **manor's model:** projects → workspaces (git worktrees) → panes/tabs
     (terminals) → tasks (agent sessions). One workspace per project is `isMain`
     ("local").
   - **Tool catalog** (the `manor` MCP): observation — `list_projects`,
     `list_workspaces`, `list_issues`, `list_panes`, **`list_tasks`** (ticket 2);
     action — `create_workspace`, `batch_create_workspaces`, `start_agent`,
     **`send_to_session`** (ticket 3, interrupt+inject — warn it may discard the
     target's in-flight work). Describe the task **handle** format returned by
     `list_tasks` and that it is the `target` for `send_to_session`.
   - **House rules (soft, behavioral for v1):**
     - Concurrency cap: do not fan out more than N agents at once (state a number,
       e.g. 4) without explicit user confirmation.
     - Confirm before destructive actions (removing workspaces, force-pushing,
       interrupting a `working` agent).
     - Do not instruct spawned child agents to themselves orchestrate/spawn
       (depth cap — avoid recursion).

2. **Wire into launch** — in ticket 4's auto-launch path, inject
   `orchestratorPrimer()` as the first prompt after the harness boots (same
   mechanism `handleNewTaskWithPrompt` uses to pass a seed prompt). For harnesses
   that support a system-prompt file, optionally also write the primer to
   `~/.manor/orchestrator/CLAUDE.md` (or the harness equivalent) — but the
   first-prompt injection is the required, harness-agnostic path.

## Files to touch
- `src/lib/orchestrator-primer.ts` — NEW primer text builder.
- `src/App.tsx` (or wherever ticket 4 placed the auto-launch) — inject primer as first prompt.
- (optional) orchestrator home-dir seed of a `CLAUDE.md`-style primer file.

## Notes
- v1 guardrails are behavioral (primer-level). Hard enforcement (rejecting
  over-cap fan-out in `batch_create_workspaces`, blocking child recursion) is an
  explicit fast-follow, not this ticket.
