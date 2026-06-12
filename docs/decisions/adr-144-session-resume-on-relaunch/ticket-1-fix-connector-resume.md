---
title: Fix getResumeCommand to preserve flags, guard double-append, add OpencodeConnector
status: done
priority: critical
assignee: sonnet
blocked_by: []
---

# Fix connector `getResumeCommand` for all agent kinds

Make the connector resume abstraction correct and complete. Today it is dead code
with stale/missing implementations. See ADR-144 for full context.

## Requirements

1. **Add a shared helper** in `electron/agent-connectors.ts`:
   ```ts
   /** True if the command already specifies session resume, so we must not append again. */
   function hasResumeToken(command: string, tokens: string[]): boolean {
     const args = command.split(/\s+/);
     return tokens.some((tok) => args.includes(tok));
   }
   ```
   Match on whole space-delimited tokens (so `-c` does not match `--continue`, and a
   path containing `resume` does not false-positive).

2. **ClaudeConnector.getResumeCommand** — preserve the full base command and append:
   - If `!sessionId` → return `null`.
   - If `hasResumeToken(baseCommand, ["--resume", "-r", "--continue", "-c"])` → return `baseCommand` unchanged.
   - Else → `` `${baseCommand} --resume ${sessionId}` ``.
   - This MUST keep flags like `--dangerously-skip-permissions` (do NOT rebuild from the binary).

3. **CodexConnector.getResumeCommand** — use the actual session id (not `--last`):
   - If `!sessionId` → return `null`.
   - If `hasResumeToken(baseCommand, ["resume"])` → return `baseCommand` unchanged.
   - Else → `` `${binary} resume ${sessionId}` `` where `binary = baseCommand.split(" ")[0] ?? "codex"`.
     (Codex resume is a subcommand; top-level flags like `--yolo` are intentionally
     dropped — documented limitation in the ADR.)

4. **Add `OpencodeConnector`** (new class implementing `AgentConnector`):
   - `kind = "opencode"`, `defaultCommand = "opencode"`.
   - `getResumeCommand`: if `!sessionId` → `null`; if
     `hasResumeToken(baseCommand, ["--session", "-s", "--continue", "-c"])` → return
     `baseCommand`; else → `` `${baseCommand} --session ${sessionId}` ``.
   - `getPromptCommand`: same escaping pattern as the other connectors.
   - `registerHooks` / `registerMcp`: no-op (opencode hook/MCP wiring is out of scope
     for this ADR; leave empty bodies with a brief comment).
   - Register it in `ensureDefaults()` alongside claude/codex/pi.

5. **PiConnector.getResumeCommand** — apply the same preserve+guard shape:
   - If `!sessionId` → `null`.
   - If `hasResumeToken(baseCommand, ["--session"])` → return `baseCommand`.
   - Else → `` `${baseCommand} --session ${sessionId}` ``.

6. **Unit tests** in `electron/__tests__/` (new file `agent-connectors-resume.test.ts`)
   covering, for each connector:
   - Appends the correct resume flag with the session id.
   - Preserves base flags (assert `--dangerously-skip-permissions` survives for claude).
   - Returns the base command unchanged when a resume token is already present
     (double-append guard) — test each guard token.
   - Returns `null` for empty `sessionId`.
   - `getConnector("opencode")` now returns the OpencodeConnector (not the Claude fallback).

## Files to touch
- `electron/agent-connectors.ts` — add `hasResumeToken`; rewrite `getResumeCommand`
  for Claude/Codex/Pi; add `OpencodeConnector`; register it in `ensureDefaults()`.
- `electron/__tests__/agent-connectors-resume.test.ts` — new test file (see above).
