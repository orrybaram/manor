---
title: A shell running a script is not the pane's shell (the laptop-closed flake)
status: todo
priority: critical
assignee: opus
blocked_by: []
---

# A shell running a script is not the pane's shell

This is ADR-231 D5, the root cause of the "laptop closed" flake (Context C3).
Read C3 first: the chain is traced there with file and line references.

## What to build

`electron/terminal-host/pty-subprocess.ts`, in `pollForegroundProcess` (`:258-294`):

- **Basename first.** Take the basename of node-pty's `ptyProcess.process`
  (it can be `/bin/sh` on Linux) before the `KNOWN_SHELLS` and
  `shellBasename` checks.
- **Tell the pane's shell from a script's shell.** When the basename is a
  known shell:
  - Find the foreground process group's leader pid:
    - on Linux, field 8 (`tpgid`) of `/proc/<ptyProcess.pid>/stat`;
    - on macOS, `ps -o tpgid= -p <pid>`.
  - If that leader is `ptyProcess.pid`, it is the pane's own shell: report
    null, as today.
  - Otherwise a shell is running something. Read the leader's argv
    (`/proc/<pid>/cmdline`, or `ps -o args= -p <pid>`):
    - If a descendant is an agent, report that agent. Reuse or generalise
      `detectAgentFromChildArgs`, which today takes the pane's shell pid,
      so it searches below the leader instead.
    - Otherwise report the script's basename, e.g. `manor-e2e-agent`, so
      the reconciler sees a non-shell foreground of no kind.
  - Any lookup that fails or times out (keep the 200 ms budgets used
    nearby) falls back to today's answer (null).
- Keep the 500 ms cadence, and keep "send only when it changed". The extra
  lookup runs only while a non-pane shell leads the foreground.
- Don't change the reconciler. `agentProcessGone` already treats a
  non-shell, no-kind foreground as the agent's child while a turn is in
  progress.

## Tests (each must fail on the base commit)

- **The sampler.** A test that drives the sampler's decision. Factor the
  decision into a pure function over `{fgName, leaderPid, shellPid,
  leaderArgs, agentBelow}` if the module's globals make a direct test
  awkward.
  - `/bin/sh` led by the pane's own shell → null.
  - `/bin/sh` leading `sh /x/manor-e2e-agent --session s` → `manor-e2e-agent`.
  - `/bin/sh` wrapping a `claude` child → `claude`.
  - A failed lookup → null.
- **The reconciler** (`electron/agent-status/__tests__/`, next to the
  existing F1 tests). Hooks SessionStart and UserPromptSubmit, then
  `paneFacts` with `foreground: {name: "manor-e2e-agent", kind: null}`. The
  status stays `thinking`, and there is no `PersistAgentStatus` effect.
  Also show today's input, `/bin/sh`, idles the pane. That pins why the
  sampler must not send it.
- **E2E.**
  - `tests/e2e/remote-host/manor-e2e-agent` gains `--linger-ms N`: after
    its last hook it sleeps N ms (e.g. `sleep` with a fraction, or a
    `node -e` timer) before `exec awk`.
  - `remote-host.spec.ts` "laptop closed" launches the stub with
    `--linger-ms 1500`. After first reading "thinking", it waits 2 s and
    asserts "thinking" again.
  - Run it on the base commit to confirm it fails there (it fails 2 of 2
    in the research), then with the fix.
- Run the "laptop closed" test 10 times on the private sshd
  (`DISPLAY=:0 node scripts/test-remote-e2e.mjs --playwright-only --no-build -- --grep "laptop closed" --repeat-each=10`)
  and 4 times in `--docker` (`sg docker -c …`). Record the counts in the
  commit message.

## Files to touch
- `electron/terminal-host/pty-subprocess.ts`: basename, leader lookup, wrapper resolution.
- `electron/terminal-host/__tests__/` (new or existing sampler test).
- `electron/agent-status/__tests__/reconciler*.test.ts`: the F1 regression test.
- `tests/e2e/remote-host/manor-e2e-agent`: `--linger-ms`.
- `tests/e2e/remote-host.spec.ts`: the linger and the re-check.
