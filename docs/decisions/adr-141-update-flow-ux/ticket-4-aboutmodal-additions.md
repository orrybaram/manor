---
title: AboutModal — Check button, last-checked, restart row
status: done
priority: high
assignee: sonnet
blocked_by: [3]
---

# AboutModal additions

Add the manual-check surface to the existing About modal at `src/components/statusbar/AboutModal/AboutModal.tsx`. Current modal: Manor logo, `v{__APP_VERSION__}`, divider, "Inspired by" links.

## Required changes

When `window.electronAPI.env.isPackaged` is true, render a new section between the version line (line ~32 currently) and the divider (line ~33):

1. **Check for Updates** button using `<Button>` from `src/components/ui/Button/Button`.
   - `disabled` while `useUpdaterStore(s => s.checking)` is true.
   - `onClick` calls `useUpdaterStore.getState().triggerManualCheck()`.
   - Use the existing button variants — pick whichever matches the modal's visual weight (likely a primary or default variant).

2. **Last-checked subtitle** beneath the button.
   - When `lastChecked === null`: "Last checked: never"
   - When `lastChecked !== null`: "Last checked: {relative}" — implement a small `formatRelativeTime(ms): string` utility inline in the component (or in a `utils/` file if one exists). Format: "just now" / "5 minutes ago" / "2 hours ago" / "3 days ago". No need for a date library — keep it dumb.
   - The string should re-compute on render. To make it update without a check happening, leave it as-is — the modal is short-lived so staleness is fine.

3. **Pending row** — render only when `pending` is non-null:
   - Layout: small box with text "Manor {pending.version} ready to install" and a `<Button>` labeled "Restart" that calls `window.electronAPI.updater.quitAndInstall()`.
   - Visually distinct from the Check section (subtle background, e.g. matching toast success styling).

When `!isPackaged`, render the modal exactly as it is today (no new sections). Wrap the additions in an `isPackaged && (...)` conditional.

## Styling

Add styles to `AboutModal.module.css` for the new section. Match the existing modal's typography and spacing — don't introduce new font sizes or colors that aren't in the existing stylesheet.

## Files to touch
- `src/components/statusbar/AboutModal/AboutModal.tsx`
- `src/components/statusbar/AboutModal/AboutModal.module.css`

## Acceptance
- Modal opens unchanged in dev (`pnpm dev`).
- In a packaged build, modal shows the new Check button + "Last checked: never" subtitle.
- Pending row hidden when `pending === null`, visible when set.
- Button disabled state visible while `checking === true`.
- `pnpm lint` and typecheck pass.

## REQUIRED: Commit your work

When your implementation is complete, you MUST create a git commit. This is not optional.

Run:
  git add -A
  git commit -m "feat(adr-141): AboutModal — Check button, last-checked, restart row"

Replace NNN with the ADR number and use the exact ticket title as the commit message body.
Do not push.
