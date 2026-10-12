---
title: PR drawer and local diff chip on the phone status line
status: done
priority: high
assignee: sonnet
blocked_by: [1]
---

# PR drawer and local diff chip on the phone status line

ADR-223 D2 + D3. Builds on `ChatStatusLine.tsx` / `chat-status-line.ts`
(commit `22f8bef9`) and `PrDetails` from ticket 1.

## PR drawer (D2)

- New `src/components/phone/ChatPane/PhonePrSheet.tsx` (+ `.module.css`):
  a Radix `Dialog` bottom sheet modelled on
  `src/components/phone/NotificationsSheet.tsx` (overlay, content anchored to
  the bottom, rounded top corners, max-height ~80svh with internal scroll,
  safe-area bottom padding, close button). Props:
  `{ open, onOpenChange, pr, workspacePath?, hostId? }`.
- Body: `<PrDetails pr workspacePath hostId />` from
  `src/components/sidebar/PrPopover.tsx`, plus an "Open on GitHub" `<Link>`
  (`ui/Link/Link`) to `pr.url`. Give `Dialog.Title` the PR title (visually
  hidden is fine) for a11y.
- On open, call `fetchPrs()` from `src/hooks/usePrWatcher` so the content is fresh.
- In `ChatStatusLine`, the PR chip becomes a `<Button>` (`ui/Button/Button`,
  styled with the existing `statusChip` class — override Button's phone
  min-height so the chip stays ~22px; see how `.composerButton` handles
  `:root[data-layout="phone"]` in `ChatPane.module.css`) that opens the sheet.
  Pass the workspace's path and its project's `hostId` (look them up via
  `find(projects, activeKey)` from `src/lib/workspace-directory`, which
  returns the project and workspace).

## Local diff chip (D3)

- `prStatusChips` in `chat-status-line.ts` is renamed/reshaped into a model
  that takes `{ pr, diffStats }` (`DiffStats` from `src/store/project-store`:
  `added`, `removed`) and returns `{ pr: …|null, ci: …|null, diff: …|null }`,
  so the line can render without a PR.
  - `diff`: `diffStats` when it has a non-zero count, else the open PR's
    `additions`/`deletions`, else null. No URL — it's an action now.
  - `pr` / `ci` as today (open PRs only).
- The diff chip becomes a `<Button>` calling
  `useAppStore.getState().openOrFocusDiff()` (as in `PhoneOverflowMenu.tsx`).
- `ChatStatusLine` renders when any of `pr`, `ci`, `diff` is non-null.
- Update `__tests__/chat-status-line.test.ts` for the new shape: local stats
  win over PR stats; zero local stats fall back to PR; diff shows with no PR;
  merged/closed PR with local stats still shows the diff.

Leave room on the right of the line (a flex spacer) — ticket 4 adds tokens there.

## Files to touch
- `src/components/phone/ChatPane/PhonePrSheet.tsx` — new
- `src/components/phone/ChatPane/PhonePrSheet.module.css` — new
- `src/components/phone/ChatPane/ChatStatusLine.tsx` — PR chip opens sheet, diff chip opens diff pane
- `src/components/phone/ChatPane/chat-status-line.ts` — model takes local diff stats
- `src/components/phone/ChatPane/__tests__/chat-status-line.test.ts` — tests
- `src/components/phone/ChatPane/ChatPane.module.css` — chip-as-button styles
