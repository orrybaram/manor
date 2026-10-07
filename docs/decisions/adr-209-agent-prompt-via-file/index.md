---
type: adr
status: proposed
database:
  schema:
    status:
      type: select
      options: [todo, in-progress, review, done]
      default: todo
    priority:
      type: select
      options: [critical, high, medium, low]
    assignee:
      type: select
      options: [opus, sonnet, haiku]
  defaultView: board
  groupBy: status
---

# ADR-209: Deliver an agent's first prompt through a file on its host

Amends ADR-176 (flattened launch line) and ADR-179 ticket 11 (server-side
pending commands).

## Context

An agent launched with a prompt — New Workspace dialog, `start-issue-work`,
`POST /agents`, `launchAgentInWorkspace` — is started by typing one line into
a fresh shell: `<harness> "<flattened, escaped prompt>"` (`agentCommandWithPrompt`
in `src/lib/agent-command.ts`). `deliverPendingCommand`
(`electron/bridge/handlers/pty.ts`) writes it with `writeAfterReady`, which
fires on the shell's *first output*.

First output is not "line editor ready". powerlevel10k's instant prompt
draws the prompt before `.zshrc` has loaded, while the tty is still in
canonical (cooked) mode. In that mode the kernel buffers one line up to
`MAX_CANON` — **1024 bytes on macOS**, 4096 on Linux — and silently drops the
rest, including the trailing `\r`. ZLE then starts, reads the surviving bytes
as typeahead and shows a half command that never runs. Observed: a ~3 KB
prompt cut at exactly 1024 bytes on a macOS host; the agent never started.

Issue bodies and hand-written prompts routinely exceed 1 KB, so this is not an
edge case. Chunking the write does not help (the limit is per line, and the
whole input queue is similarly bounded), and Manor cannot see the tty's
termios from Node to wait for raw mode.

## Decision

Keep the line typed into the shell short; move the prompt out of band.

1. **Structured pending command.** `PendingCommand`
   (`electron/layout/pending-commands.ts`) gains an optional `prompt`. For an
   agent launch, `text` is the bare harness command (`claude
   --dangerously-skip-permissions`) and `prompt` is the raw, unflattened
   prompt. `PendingCommandOptions` carries `prompt`; `layoutSetPendingCommand`
   validates it is a string. `requeue` keeps it (already spreads the entry).

2. **Delivery writes the prompt file on the pane's host.** In
   `deliverPendingCommand`, when `pending.prompt` is set:
   - `host = deps.backendRegistry.get(hostId)` (the host the session runs on,
     `result.hostId` — not `RoutedBackend.shell`, which routes by path; same
     reasoning as ADR-187's paste-image upload).
   - `file = <home>/.manor/prompts/<paneId>-<8 hex>.txt`, written with
     `host.shell.writeFile` (atomic rename on the daemon).
   - Typed line: `agentCommandWithPromptFile(text, file)` →
     `<harness> "$(cat '<file>'; rm -f '<file>')"` + `\r`. The path is
     single-quoted with `'` → `'\''` escaping. The shell deletes the file as
     it reads it.
   - Fire-and-forget `find <dir> -type f -mtime +7 -delete` like
     `paste-image.ts`, for files whose launch never ran.
   - If the write fails on a **local** host, fall back to today's inline line
     (`agentCommandWithPrompt(text, prompt)`) — short prompts still work and a
     long one is no worse than before. On a remote host the existing requeue
     path applies unchanged.

3. **Producers pass the prompt separately** instead of baking it into `text`:
   `startAgentInWorkspace` (`electron/routes/agents.ts`), and on the renderer
   `addTerminalTab(command, { kind, prompt })` → `sendPendingCommand(…, {
   submit, prompt })`, used by `launchAgentInWorkspace`
   (`src/lib/agent-prompt-launch.ts`) and `createWorktree`
   (`src/store/project-store.ts`), which keeps the base command and prompt
   apart until the tab is opened.

4. **The prompt is no longer flattened** on this path: `"$(cat …)"` passes
   newlines through intact, and `$(…)` strips only trailing newlines.
   `flattenPrompt` stays for `review-submit.ts` (typing into a running
   harness) and the inline fallback.

## Consequences

- Prompts of any length (up to the daemon's 20 MiB write limit) launch
  reliably on macOS and Linux, local and remote, including prewarmed/adopted
  sessions — nothing depends on the shell's spawn env.
- Multi-line prompts reach the agent with their formatting.
- Shell history shows `claude "$(cat '…/prompts/…'; rm -f '…')"` instead of
  the prompt; re-running it from history fails (file is gone). Acceptable:
  history replay of a launch line was never a supported path.
- Requires a POSIX-ish shell with `$(…)` inside double quotes: bash, zsh,
  fish ≥ 3.4. nushell/PowerShell were never supported by the existing
  double-quote escaping either.
- One extra round trip (homeDir + writeFile) before the line is typed; on a
  remote host this is an ssh RPC, small next to agent startup.
- A stale prompt file can linger if a launch line is never executed (pane
  closed first); the 7-day sweep bounds that. Prompts may contain sensitive
  text, so files live under `~/.manor` (user-only home dir) and are deleted on
  read.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
