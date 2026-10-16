---
title: HostRowShell gains defaultOpen and a detail line
status: in-progress
priority: high
assignee: sonnet
blocked_by: []
---

# HostRowShell gains defaultOpen and a detail line

ADR-237 D3. The project page's per-host rows reuse `HostRowShell` from
`src/components/settings/HostsPage/HostRow.tsx`. It needs two more props.

1. `HostRowShellProps` gains:
   - `defaultOpen?: boolean` — "Open on mount, before any jump; a lone
     project's only row (ADR-237 D3)." Default `false`.
   - `detail?: ReactNode` — "A third line under the status: the project's
     path on this host (ADR-237 D3)."
2. `useState(jump === sectionId)` becomes
   `useState(defaultOpen || jump === sectionId)`.
3. In the header, after the `.rowStatus` span inside `.rowText`, render
   `{detail && <span className={styles.rowDetail}>{detail}</span>}`.

`src/components/settings/HostsPage/HostsPage.module.css`: after `.rowStatus`
add

```css
/* The row's third line: a path, in mono, cut short (ADR-237 D3). */
.rowDetail {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

Check that `.rowText` has `min-width: 0` so the ellipsis works; add it if
not.

Nothing on the Hosts page changes: `HostRow` and `ThisMacRow` pass neither
prop.

## Files to touch
- `src/components/settings/HostsPage/HostRow.tsx` — `HostRowShellProps`, open state, detail line
- `src/components/settings/HostsPage/HostsPage.module.css` — `.rowDetail`

## Acceptance
- `pnpm typecheck` and `pnpm test:unit` pass.
