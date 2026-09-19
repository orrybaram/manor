---
title: Flatten multi-line prompts and consolidate launch resolution
status: done
priority: critical
assignee: sonnet
blocked_by: [1]
---

# Flatten multi-line prompts and consolidate launch resolution

Discovered while verifying ticket 1. The new `start-agent` handler seeds the
prompt into a double-quoted shell argument without flattening newlines, and
hand-rolls launch-command resolution that `src/lib/agent-prompt-launch.ts`
already owns.

**This defeats the ADR's stated goal on the most common path.** `renderPrompt`
(`electron/routes/projects.ts:146`) builds the default batch prompt as
`` `Work on GitHub issue #${number}: ${title}\n\n${body}` `` — *always*
multi-line — and `--prompt-template` accepts multi-line templates too. So every
default `batch-create-workspaces` launch sends a prompt containing newlines.
`escapeShellDoubleQuoted` (`src/lib/home.ts`) does not touch newlines, so the
shell either sits on a continuation prompt or submits the turn early on the
first blank line. ADR-176 exists to make fan-out start agents "with the correct
prompt"; without this it does not.

## What to build

### 1. Flatten the prompt in the `start-agent` handler

`src/lib/app-commands.ts` — import `flattenPrompt` from
`./agent-prompt-launch` and apply it to `prompt` before
`escapeShellDoubleQuoted`, exactly as `startAgentWithPrompt` does:

```ts
const flat = flattenPrompt(prompt);
const command = `${base} "${escapeShellDoubleQuoted(flat)}"`;
```

`flattenPrompt` already exists and is documented for precisely this hazard —
do not write a second copy.

### 2. Collapse the duplicated launch path

`startAgentWithPrompt` (`src/lib/agent-prompt-launch.ts:27`) and the new
`start-agent` handler now do the same job with different gaps:

| | `startAgentWithPrompt` | ticket 1's handler |
| --- | --- | --- |
| flattens the prompt | yes | **no** |
| home-harness (`isHomePath`) command | **no** (`getAgentCommand` ignores it) | yes |
| `selectWorkspace` → sidebar highlight follows | yes | **no** |
| caller-supplied `agentCommand` override | no | yes |

Neither is a superset, so this is a genuine consolidation, not a style
preference. Factor out one shared helper in `src/lib/agent-prompt-launch.ts`
that both call — it must do **all** of: `selectWorkspace` through the project
store, `setActiveWorkspace`, home-harness-aware command resolution with an
optional explicit override, `flattenPrompt`, `setPendingStartupCommand` keyed
to the passed `workspacePath`, and `addTab()` returning its
`{ tabId, paneId }`.

Prefer extending `getAgentCommand` (`src/agent-defaults.ts:30`) to handle
`isHomePath` via `homeLaunchCommand` over keeping a second resolver, **but
only if** no existing `getAgentCommand` caller would regress from that change
— check every call site first and say so in your report if you decide against
it.

Keep the handler's public contract identical: same arguments, same
`{ tabId, paneId, workspacePath }` return, same throw when `addTab()` returns
`null`. This is a refactor behind a stable interface plus one bug fix.

### 3. Tests

In `src/lib/__tests__/app-commands.test.ts`, extend the `start-agent` suite:

- a prompt containing `\n\n` (the exact shape `renderPrompt` produces) reaches
  `setPendingStartupCommand` as a **single line** — this is the regression test;
- the sidebar selection follows: `selectWorkspace` is called for the target
  workspace's project.

Keep every existing `start-agent` case passing unchanged — including
`"seeds the bare launch command when no prompt is given"`, which ticket 1 added
deliberately and which must not regress. Add matching coverage to whatever
suite already exercises `startAgentWithPrompt`.

## Files to touch
- `src/lib/app-commands.ts` — flatten the prompt; call the shared helper instead of the local `resolveLaunchCommand`.
- `src/lib/agent-prompt-launch.ts` — the shared helper; `startAgentWithPrompt` becomes a thin caller.
- `src/agent-defaults.ts` — only if you extend `getAgentCommand` for `isHomePath`.
- `src/lib/__tests__/app-commands.test.ts` — newline-flattening regression test, sidebar-selection test.

## REQUIRED: Commit your work

When your implementation is complete, you MUST create a git commit. This is not optional.

Run:
  git add -A
  git commit -m "fix(adr-176): Flatten multi-line prompts and consolidate launch resolution"

Do not push.
