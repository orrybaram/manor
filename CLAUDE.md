# manor

Electron + TypeScript desktop app for running coding agents in terminal panes. Use pnpm, not npm, yarn or bun. Name domain concepts as `CONTEXT.md` does; read it before naming anything new.

## Done means verified

- `pnpm typecheck` and `pnpm test` (Vitest + knip) pass. A few unit tests already fail on an untouched `main`; re-run a failing file there before calling it yours.
- For a UI change, see it work in the running app (the `run` skill) or in a Playwright spec, and show the screenshot. Run Playwright yourself in the background, not in a subagent: one run can outlast a subagent's silence watchdog.

## Larger features

Plan before coding and put the agreed plan in the GitHub issue or PR body, not in the repo: the files to touch, what's out of scope, and how to verify it end to end. Rationale lives in issues and PRs.

## Git

- No `Co-Authored-By` trailers; the user is the sole author of every commit.
- Other sessions share this checkout, so stage files by path and isolate work in a worktree instead of `git stash`.
