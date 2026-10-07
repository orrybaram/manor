---
title: Deliver pending agent prompts through a file on the pane's host
status: done
priority: critical
assignee: opus
blocked_by: []
---

# Deliver pending agent prompts through a file on the pane's host

See ADR-209 §1, §2 and the `POST /agents` part of §3. TDD: write failing tests first.

## Changes

1. `src/lib/agent-command.ts` — add exported
   `agentCommandWithPromptFile(base: string, filePath: string): string`
   returning `` `${base} "$(cat ${q}; rm -f ${q})"` `` where `q` is the path
   single-quoted (`'` → `'\''`). Keep the file zero-imports. Update the header
   comment (it says `agentCommandWithPrompt` is the one place a launch line is
   built). Unit-test it next to existing agent-command tests (find them with
   grep), including a path containing a space and a `'`.

2. `electron/layout/pending-commands.ts` — `PendingCommand.prompt?: string`,
   `PendingCommandOptions.prompt?: string`; `set` stores it (omit the key when
   undefined). `requeue` already spreads.

3. `electron/bridge/handlers/layout.ts` `layoutSetPendingCommand` — validate
   `opts.prompt` is a string when present (mirror the `submit` check).

4. `electron/bridge/handlers/pty.ts` `deliverPendingCommand` — when
   `pending.prompt` is set, build the line by writing the prompt to the host:
   - `const host = deps.backendRegistry.get(hostId)`; `home = await host.shell.homeDir()`;
     dir `${home}/.manor/prompts`; file `path.posix.join(dir, `${paneId}-${crypto.randomBytes(4).toString("hex")}.txt`)`;
     `await host.shell.writeFile(file, Buffer.from(pending.prompt, "utf-8"))`.
   - line = `agentCommandWithPromptFile(pending.text, file)`.
   - fire-and-forget `host.shell.exec("find", [dir, "-type", "f", "-mtime", "+7", "-delete"]).catch(() => {})`.
   - If homeDir/writeFile throws and `hostId === LOCAL_HOST_ID`, fall back to
     `agentCommandWithPrompt(pending.text, pending.prompt)`. On a remote host,
     let it fall into the existing catch so requeue applies.
   - Then the existing `writeAfterReady(paneId, line + "\r")` (respect `submit`).
   Model the host write on `electron/ipc/paste-image.ts`. Update the
   function's doc comment.

5. `electron/routes/agents.ts` `startAgentInWorkspace` — queue `base` as text
   with `{ prompt: options.prompt }` (only when the prompt is non-empty after
   trim, matching current `agentCommandWithPrompt` behaviour of ignoring empty
   prompts) instead of `agentCommandWithPrompt(base, options.prompt)`. Update
   its doc comment (it mentions flattening).

## Tests
- `electron/bridge/handlers/__tests__/pty-pending-command.test.ts`: prompt is
  written to `<home>/.manor/prompts/…` on the session's host via the registry,
  typed line is the short `$(cat …)` form + `\r`; local write failure falls
  back to the inline line; remote write failure requeues with prompt intact;
  no prompt → unchanged behaviour.
- `electron/routes/agents-launch.test.ts`: queued entry has bare base text and
  the prompt.
- pending-commands / layout handler validation as appropriate.

## Files to touch
- `src/lib/agent-command.ts` (+ its test)
- `electron/layout/pending-commands.ts`
- `electron/bridge/handlers/layout.ts`
- `electron/bridge/handlers/pty.ts`
- `electron/bridge/handlers/__tests__/pty-pending-command.test.ts`
- `electron/routes/agents.ts`
- `electron/routes/agents-launch.test.ts`
