---
title: Document the E2E suite in README
status: in-progress
priority: low
assignee: haiku
blocked_by: [3]
---

# Document the E2E suite in README

Add a short subsection to the project README explaining how to run the Playwright smoke suite. Keep it brief — the `tests/e2e/README.md` created in ticket 1 has the details.

## What to do

1. Read `README.md` and locate the "Testing" or equivalent section (likely near the bottom, after "Getting Started").

2. Add a new subsection titled **"End-to-end tests"** (or add it alongside the existing testing guidance):
   - One sentence explaining what the suite covers (pane lifecycle smoke).
   - The command: `pnpm test:e2e`.
   - A note: "Runs a full `vite build` first; expect 30–60s per run."
   - A pointer to `tests/e2e/README.md` for details on adding new tests.

3. Do NOT restructure other sections. Do NOT update "Getting Started". This is a minimal addition.

4. Keep the whole subsection under 10 lines of markdown.

## Files to touch

- `README.md` — add "End-to-end tests" subsection.

## Verification

- `README.md` renders cleanly (no broken markdown).
- Running the command documented actually works (`pnpm test:e2e` from a fresh clone).

## REQUIRED: Commit your work

When your implementation is complete, you MUST create a git commit. This is not optional.

Run:
  git add -A
  git commit -m "docs(adr-128): Document the E2E suite in README"

Do not push.
