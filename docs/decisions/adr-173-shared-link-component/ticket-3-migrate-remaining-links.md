---
title: Migrate settings, nudge, about and port links to Link
status: done
priority: medium
assignee: haiku
blocked_by: [1, 2]
---

# Migrate settings, nudge, about and port links to Link

Replace the remaining hand-rolled external links with `<Link>` from
`src/components/ui/Link/Link` (see `src/components/sidebar/PrPopover.tsx` after
ticket 2 for a finished example). Every one of these currently calls
`window.electronAPI.shell.openExternal` from a click handler; after this ticket
none of them should.

## Changes

1. **`src/components/settings/GitHubIntegrationSection.tsx`** — the
   "Install GitHub CLI" `<a className={styles.linearLink} href="#" onClick=...>`
   → `<Link href="https://cli.github.com">Install GitHub CLI</Link>`
   (default `inline` variant, no className, no onClick).
2. **`src/components/settings/LinearIntegrationSection.tsx`** — the
   "Linear Settings" `<a href="#">` → `<Link href="https://linear.app/trytango/settings/account/security">Linear Settings</Link>`.
3. **`src/components/settings/SettingsModal/SettingsModal.module.css`** —
   delete `.linearLink` and `.linearLink:hover` if nothing else references
   `linearLink` (search `src/` first).
4. **`src/components/sidebar/GitHubNudge.tsx`** — the raw
   `<button className={styles.nudgeLink} onClick=...>GitHub CLI</button>` →
   `<Link href="https://cli.github.com" className={styles.nudgeLink}>GitHub CLI</Link>`.
   Keep `nudgeLink` styling (it uses `--text-selected` + underline, which is
   intentional for the nudge), but in `src/components/EmptyState.module.css`
   remove the button-reset declarations that no longer apply to an anchor
   (`background`, `border`, `padding`, `font`). Keep color, cursor,
   text-decoration, text-underline-offset, and the hover rule.
5. **`src/components/statusbar/AboutModal/AboutModal.tsx`** — the markdown `a`
   renderer → `href ? <Link href={href} title={href}>{children}</Link> :
   <span>{children}</span>`. The existing `.changelog :global(a)` rule in
   `AboutModal.module.css` can stay.
6. **`src/components/ports/PortBadge.tsx`** — the inline
   `<div role="button" onClick={handleOpenExternal}>` wrapping
   `<ExternalLink ... />` → `<Link variant="plain" href={url}
   aria-label="Open in default browser" onClick={(e) => e.stopPropagation()}>`.
   Keep `handleOpenExternal` — the "Open in Default Browser" context-menu item
   still uses it via `onSelect`.

Do NOT touch (see ADR "Deliberately not migrated"): `ProjectItem.tsx`,
`TerminalPane.tsx`, `IssueDetailView.tsx`, `GitHubIssueDetailView.tsx`,
`FeedbackModal.tsx`, hooks, `menu-handlers.ts`, `notification-navigation.ts`,
`pr-notifications.ts`.

## Verify

`pnpm exec tsc --noEmit`, `pnpm lint`, `pnpm test`.

## Files to touch
- `src/components/settings/GitHubIntegrationSection.tsx` — Install GitHub CLI link
- `src/components/settings/LinearIntegrationSection.tsx` — Linear Settings link
- `src/components/settings/SettingsModal/SettingsModal.module.css` — remove orphaned `.linearLink`
- `src/components/sidebar/GitHubNudge.tsx` — GitHub CLI link
- `src/components/EmptyState.module.css` — trim button resets from `.nudgeLink`
- `src/components/statusbar/AboutModal/AboutModal.tsx` — changelog markdown links
- `src/components/ports/PortBadge.tsx` — external-link icon
