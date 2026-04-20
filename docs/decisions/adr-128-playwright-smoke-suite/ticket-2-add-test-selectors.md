---
title: Add data-testid selectors to smoke-test touch points
status: in-progress
priority: high
assignee: sonnet
blocked_by: [1]
---

# Add data-testid selectors to smoke-test touch points

Add minimal, stable `data-testid` attributes to the DOM nodes the smoke test will query. Do NOT add testids broadly — only the exact nodes listed below. Future tests can add more as they're written.

## Selector vocabulary (authoritative list)

Use these exact strings. No others.

| `data-testid` | Where | Purpose |
|---|---|---|
| `sidebar-new-workspace-button` | Sidebar action that opens `NewWorkspaceDialog` for a selected project | Entry into workspace creation |
| `new-workspace-dialog` | `NewWorkspaceDialog` root (Radix `Dialog.Content`) | Wait for dialog to open |
| `new-workspace-project-select` | Project dropdown trigger inside the dialog | Fill form |
| `new-workspace-name-input` | Name input inside the dialog | Fill form |
| `new-workspace-base-branch-select` | Base branch dropdown trigger | Fill form |
| `new-workspace-submit` | Submit/Create button inside the dialog | Submit form |
| `workspace-pane` | Root element of each pane in the layout tree | Count panes |
| `terminal-pane` | Root of `TerminalPane` component | Detect terminal rendered |
| `project-setup-wizard` | Root of the setup wizard (if it opens on fresh launch) | Smoke test can dismiss or complete it |
| `import-project-button` | Button in sidebar/empty-state that opens the "add existing project" flow | Seed the test project into the app |
| `import-project-path-input` | Path input in the import-project flow | Point at the seeded temp repo |
| `import-project-submit` | Submit button for import-project | Finalize import |

## What to do

1. Locate each target component. Use Grep/Read. Best starting points:
   - `src/components/sidebar/NewWorkspaceDialog/NewWorkspaceDialog.tsx`
   - `src/components/sidebar/` — find the button/menu that opens `NewWorkspaceDialog`.
   - `src/components/workspace-panes/TerminalPane/TerminalPane.tsx` — root div.
   - `src/components/workspace-panes/` — find the pane-tree renderer; add testid to the per-pane container.
   - Project setup wizard: `src/components/` (look for `ProjectSetupWizard` or similar, referenced in ADR-125).
   - Import project flow: may live inside the setup wizard or a sidebar dialog — find the path input + submit button.

2. Add `data-testid="..."` as a plain HTML attribute on the appropriate node. For Radix primitives (Dialog.Content, Select.Trigger, etc.), pass it through — Radix forwards unknown props to the underlying DOM element.

3. Do NOT add the testid if the exact node doesn't exist yet — flag it in your final report and we'll adjust in ticket 3. Specifically, if the "import project" UI doesn't exist as described (e.g., project import happens via a native file picker, not a DOM input), document what the actual flow is so ticket 3 can be written against reality.

4. Do NOT add `data-testid` anywhere outside the list above. If you think another node needs one, leave it for ticket 3.

## Files to touch

Likely files (verify via Grep before editing):
- `src/components/sidebar/NewWorkspaceDialog/NewWorkspaceDialog.tsx`
- `src/components/sidebar/` (the component that opens the dialog)
- `src/components/workspace-panes/TerminalPane/TerminalPane.tsx`
- `src/components/workspace-panes/` (pane-tree renderer)
- The setup wizard component (path TBD — find it)
- The import-project component (path TBD — find it)

## Verification

- `pnpm test` still passes.
- `pnpm lint` passes.
- `pnpm test:e2e` still passes (the placeholder test from ticket 1 is unaffected).
- Open the app manually (`pnpm dev`), inspect DOM in devtools, verify each testid in the vocabulary above is present on exactly one element (or zero, if the ticket couldn't find the target — documented).

## REQUIRED: Commit your work

When your implementation is complete, you MUST create a git commit. This is not optional.

Run:
  git add -A
  git commit -m "feat(adr-128): Add data-testid selectors to smoke-test touch points"

Do not push.
