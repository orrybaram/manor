---
title: PR badge colors by readiness, corner dot removed
status: done
priority: high
assignee: sonnet
blocked_by: [1]
---

# PR badge colors by readiness, corner dot removed

In `src/components/sidebar/PrPopover.tsx`:

1. Import `prReadiness` from `../../lib/pr-readiness`.
2. Replace `badgeClass`, `hasUnresolved`, `allChecksPassing`, `isApproved`,
   `isAllGreen`, and `dotClass` with:

```ts
const readiness = prReadiness(pr);
const badgeClass = {
  ready: styles.prReady,
  blocked: styles.prBlocked,
  pending: styles.prPending,
  merged: styles.prMerged,
  closed: styles.prClosed,
}[readiness];
```

3. Remove `{dotClass && <span className={dotClass} />}` from the trigger.
4. Add `data-readiness={readiness}` and `data-draft={pr.isDraft ? "true" : "false"}`
   to the trigger `<span>`.
5. Add `styles.prDraft` to the trigger class list when `pr.isDraft && readiness !== "merged" && readiness !== "closed"`.
6. Keep `PrIcon`, `stateLabel`, `stateClass` and all popover content exactly
   as they are. The popover still lists checks, review, threads and Draft. Keep
   `commentsElement` as-is (it reads `pr.unresolvedThreads` directly).

In `src/components/sidebar/PrPopover.module.css`:

- Delete `.prBadgeDotWarning`, `.prBadgeDotSuccess` and their shared rule.
- Rename `.prOpen` → `.prReady` (same green styling).
- Add:

```css
.prBlocked { color: var(--red); background: var(--red-a20); }
.prPending { color: var(--text-dim); background: var(--hover); }
.prDraft   { outline: 1px dashed currentColor; outline-offset: -1px; }
```

- Change `.prClosed` to `color: var(--text-dim); background: none;` (the
  GitPullRequestClosed icon already distinguishes it from pending).
- `.prMerged` unchanged.

`--red-a20` and `--green-a20` are already used by this file; `--hover` is used
by `ProjectItem.module.css`. Do not introduce new tokens.

Run `pnpm typecheck` and `pnpm test` and make them pass.

## Files to touch
- `src/components/sidebar/PrPopover.tsx` — badge class from `prReadiness`, remove corner dot, draft outline
- `src/components/sidebar/PrPopover.module.css` — new readiness classes, delete dot classes
