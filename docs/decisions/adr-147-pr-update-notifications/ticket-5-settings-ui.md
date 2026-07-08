---
title: Add PR notification toggles to settings
status: done
priority: medium
assignee: sonnet
blocked_by: [2]
---

# Add PR notification toggles to settings

Add a "Pull requests" section to the notifications settings page with four
switches bound to the new preferences.

## Files to touch

- `src/components/settings/NotificationsPage.tsx`
  - Below the existing "Notify me when..." `Stack`, add a new section using the
    same markup patterns (`styles.sectionTitle`, `styles.notifRow`, `<Switch>`
    from `ui/Switch/Switch`).
  - Section title: "Pull requests".
  - Four rows, each a `<label className={styles.notifRow}>` with a `<span>` and a
    `<Switch>`:
    - "New comment" → `notifyOnPrComment`
    - "Review approved" → `notifyOnPrApproved`
    - "Changes requested" → `notifyOnPrChangesRequested`
    - "CI checks failed" → `notifyOnPrChecksFailed`
  - Bind each like the existing rows:
    `checked={preferences.notifyOnPrComment}`
    `onCheckedChange={(c) => set("notifyOnPrComment", c)}`.

## Notes
- Use `<Switch>` from `src/components/ui/Switch/Switch` — never a raw checkbox
  (see `.claude/rules/ui-components.md`).
- Keep it visually consistent with the existing agent-notification rows.
