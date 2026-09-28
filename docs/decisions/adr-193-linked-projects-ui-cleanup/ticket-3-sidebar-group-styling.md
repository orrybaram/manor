---
title: Clean up linked group rendering in the sidebar
status: todo
priority: high
assignee: sonnet
blocked_by: []
---

# Clean up linked group rendering in the sidebar

ADR-193 §3. Markup and CSS only; keep all behavior, handlers and
`data-testid`s.

- `ProjectItem.tsx` `variant="section"`:
  - Don't apply `styles.project` border or `styles.projectSelected` on the
    outer wrapper for a section (use a `styles.section` wrapper instead).
  - Section header content: host icon (`Laptop` for local, `Cloud` for remote,
    size 11) + host name text ("This machine" or the remote host's label from
    the host store — reuse whatever `HostIndicator`/`LocalHostLabel` uses to
    resolve the label, but render plain text, not the chip). For a remote
    host, a small right-aligned connection dot (reuse the host status color
    logic from `HostIndicator` if exposed; otherwise `isHostOffline`).
  - The chevron is visually hidden unless the header is hovered/focused or the
    section is collapsed (CSS: `.sectionHeader .projectChevron { opacity: 0 }`
    with `:hover`, `:focus-visible`, `[aria-expanded="false"]` overrides).
    Keep its layout width so text doesn't shift.
- `ProjectItem.module.css`:
  - `.sectionHeader`: height ~20px, font-size 11px, font-weight 500,
    `color: var(--text-dim)` (also when the group is selected — override
    `.projectSelected > .projectHeader` color for sections), no background.
  - Remove `.groupSections { padding-left: 8px }`; add `gap`/margin of 6px
    between sections. Workspace rows in a section must align with a lone
    project's workspace rows.
  - The group header's link icon stays dim; keep `.groupStateWarn` etc.
- `ProjectGroupItem.tsx`: adjust wrapper classes as needed; no behavior
  change.
- Check with `LocalHostLabel` usage elsewhere before changing it; prefer a new
  small component in `ProjectItem.tsx` (e.g. `SectionHostLabel`) over changing
  shared ones.
- Update sidebar tests only if they asserted removed markup.

## Files to touch
- `src/components/sidebar/ProjectItem.tsx`
- `src/components/sidebar/ProjectItem.module.css`
- `src/components/sidebar/ProjectGroupItem.tsx`
