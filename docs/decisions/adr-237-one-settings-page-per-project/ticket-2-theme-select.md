---
title: Project theme picker becomes a select; General section two-column
status: todo
priority: high
assignee: sonnet
blocked_by: [1]
---

# Project theme picker becomes a select; General section two-column

ADR-237 D4. `ProjectThemeSelector` in
`src/components/settings/ProjectSettingsPage.tsx` is a search input plus an
always-open list. Make it a `SearchableSelect`.

1. Keep the `useMountEffect` that loads `hasGhostty` and `allColors`, the
   `entries` memo and `handleSelect`. Delete `query`, `highlightIndex`,
   `itemRefs`, `filtered`, `handleSelectByIndex`, `scrollToHighlight`,
   `handleKeyDown` and the `useListKeyboardNav` import.
2. Build options from `entries`: `{ value: entry.name, label:
   entry.displayName, trailing: <>{badge}{dots}</> }` where the badge is
   `<span className={styles.themeItemBadge}>` (only when `entry.badge`) and
   the dots are the existing `Row gap="xs" className={styles.themePreview}`
   of six `styles.colorDot` spans (only when `allColors[entry.name]`).
3. Render:
   ```tsx
   <label className={styles.fieldLabel} htmlFor="project-theme">Theme</label>
   <SearchableSelect
     id="project-theme"
     value={selectedName}
     onChange={handleSelect}
     options={options}
     listMaxHeight={320}
     className={styles.fullWidthSelect}
     data-testid="project-theme-select"
   />
   ```
   `selectedName` is `project.themeName ?? "__global__"` as today.
4. In the lone-project `ProjectSettingsPage` (and `GroupSettingsPage`,
   until ticket 5 merges them), wrap the Name field and the theme selector
   in `<div className={styles.generalGrid}>`, each in its own
   `<Stack gap="xs">`, with `ColorField` below the grid. `NameField` and
   `ProjectThemeSelector` return fragments today; give each a wrapping
   `Stack gap="xs"` so the grid cells align.
5. Remove the `Input` import if nothing else in the file uses it (the
   Agent and Commands sections still do; check). Keep `Check`.

`src/components/settings/SettingsModal/SettingsModal.module.css`: add near
`.fieldLabel`:

```css
/* Name and Theme side by side (ADR-237 D2). */
.generalGrid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px 20px;
}

.fullWidthSelect {
  width: 100%;
  max-width: none;
}
```

Stack the grid to one column under the phone layout
(`:global(:root[data-layout="phone"]) .generalGrid { grid-template-columns: 1fr; }`),
next to the other phone rules at the end of the file.

Leave `.themeSearch`, `.themeList`, `.themeItem*` alone: `ThemeSection.tsx`
(Appearance) still uses them.

## Files to touch
- `src/components/settings/ProjectSettingsPage.tsx` — `ProjectThemeSelector` rewrite, General grid
- `src/components/settings/SettingsModal/SettingsModal.module.css` — `.generalGrid`, `.fullWidthSelect`, phone rule

## Acceptance
- `pnpm typecheck` and `pnpm test:unit` pass.
- Opening a project's settings shows Name and Theme side by side; the theme
  trigger shows the chosen theme's badge and dots; the popover searches and
  Arrow/Enter pick a theme.
