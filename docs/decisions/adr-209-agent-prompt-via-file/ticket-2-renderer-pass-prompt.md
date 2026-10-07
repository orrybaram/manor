---
title: Renderer launches pass the prompt separately from the command
status: todo
priority: high
assignee: sonnet
blocked_by: [1]
---

# Renderer launches pass the prompt separately from the command

See ADR-209 §3. Ticket 1 added `prompt` to `PendingCommandOptions` and to
`layout.setPendingCommand`'s validation; the server writes it to a file.

## Changes
1. `src/store/app-store.ts` — `sendPendingCommand` opts gain `prompt?: string`;
   `addTerminalTab` opts gain `prompt?: string` (type in the store interface
   too) and forward it. Check `src/electron.d.ts` / preload typing for
   `layout.setPendingCommand` and add `prompt` there if its opts type is
   spelled out.
2. `src/lib/agent-prompt-launch.ts` — `addTerminalTab(base, { kind:
   "agent-startup", prompt: options.prompt })` (omit when empty/whitespace)
   instead of `agentCommandWithPrompt`.
   Also `startAgentInBackground` in the same file (added by a parallel
   session after this ticket was written; launches from the Dashboard via
   `addTerminalTabIn`) — same change; `addTerminalTabIn` opts gain `prompt`
   and forward it to `sendPendingCommand`. If either function has moved,
   cover every remaining caller of `agentCommandWithPrompt` in `src/`.
3. `src/store/project-store.ts` `createWorktree` — stop building
   `agentCommandWithPrompt`; keep `agentCommand` (base: `opts.agentCommand ??
   project command ?? DEFAULT` only when a prompt or explicit command exists,
   preserving today's "no prompt and no explicit command → no agent tab"
   behaviour) and pass `prompt: agentPrompt` to both `addTerminalTab` calls
   (~lines 1111–1130). Note `opts.agentCommand`, when given, already carries
   any prompt and must not get one added.
4. Update existing tests that asserted the inlined `"<prompt>"` line
   (grep tests for `agentCommandWithPrompt`, `addTerminalTab`, `agentPrompt`).
   Add assertions that the prompt is passed via opts.
5. If `agentCommandWithPrompt` now has only the server fallback caller, leave
   it exported; update `agent-command.ts`'s header comment to match.

## Files to touch
- `src/store/app-store.ts`
- `src/electron.d.ts` (if needed) / preload
- `src/lib/agent-prompt-launch.ts`
- `src/store/project-store.ts`
- related tests under `src/`
