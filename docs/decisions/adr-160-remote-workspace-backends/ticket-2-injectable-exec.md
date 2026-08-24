---
title: Make git/shell/ports backends take an injectable Exec
status: todo
priority: high
assignee: sonnet
blocked_by: []
---

# Make git/shell/ports backends take an injectable Exec

`electron/backend/exec.ts` is currently a single `execFileAsync` export. The local git,
shell, and ports backends call it (and `spawn`, `execFileSync`, `readFile`) directly, so
their command-construction logic cannot be reused against a remote host.

Widen `exec.ts` into an injected surface and thread it through, with **no behavior
change**. All command construction, argument arrays, timeouts, and error handling stay
exactly where they are.

Define in `electron/backend/exec.ts`:

```ts
export interface Exec {
  file(cmd: string, args: string[], opts?: { cwd?: string; timeout?: number; maxBuffer?: number }):
    Promise<{ stdout: string; stderr: string }>;
  stream(cmd: string, args: string[], opts: { cwd?: string }, cb: {
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
    onExit: (result: { exitCode: number | null }) => void;
  }): { cancel: () => void };
  readFile(path: string, encoding: "utf-8"): Promise<string>;
}

export const localExec: Exec = { /* execFile/spawn/fs.readFile as today */ };
```

Then give `LocalGitBackend`, `LocalShellBackend`, and `LocalPortsBackend` an optional
constructor parameter `exec: Exec = localExec` and replace their direct
`execFileAsync` / `spawn` / `readFile` calls with `this.exec.*`.

Note `LocalGitBackend` also uses `execFileSync` — convert that call site to the async
`file()` path if it is straightforward; if it is load-bearing as sync, leave it and say
so in the commit body (it will need handling in ticket 8).

`local-backend.ts` keeps constructing them with no argument, so its behavior is
identical. Existing tests in `electron/backend/__tests__/` and `local-git.test.ts`,
`local-ports.test.ts`, `local-shell.test.ts` must keep passing unchanged; if a test
mocks `child_process` directly it may now be simpler to inject a fake `Exec` — that is
allowed, but keep the assertions.

## Files to touch
- `electron/backend/exec.ts` — define `Exec`, implement `localExec`.
- `electron/backend/local-git.ts` — inject exec; replace `execFileAsync`, `spawn` (in
  `pushStream`), `readFile`, and `execFileSync` usage.
- `electron/backend/local-shell.ts` — inject exec.
- `electron/backend/local-ports.ts` — inject exec.
- `electron/backend/local-backend.ts` — pass `localExec` explicitly for clarity.
- `electron/backend/local-git.test.ts`, `local-ports.test.ts`, `local-shell.test.ts` —
  adapt mocking only if required.
