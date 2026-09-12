---
title: Add ui/Link component and rule
status: in-progress
priority: high
assignee: sonnet
blocked_by: []
---

# Add ui/Link component and rule

Create a shared external-link component. See the ADR's Decision section for
the full contract.

## Implementation

`src/components/ui/Link/Link.tsx` — mirror `src/components/ui/Button/Button.tsx`:

```tsx
import React from "react";
import styles from "./Link.module.css";

type LinkVariant = "inline" | "plain";

type LinkProps = Omit<
  React.AnchorHTMLAttributes<HTMLAnchorElement>,
  "href" | "target"
> & {
  /** http(s) only — Electron's window-open handler ignores other schemes. */
  href: string;
  variant?: LinkVariant;
};
```

- `React.forwardRef<HTMLAnchorElement, LinkProps>`, named function `Link`,
  destructure `props` on the first line of the body (see the `react` skill
  conventions: `type` not `interface`, `props` param).
- Render `<a ref={ref} href={href} target="_blank" rel="noreferrer" className={...} {...rest} />`.
  Put `target`/`rel` AFTER `{...rest}` is spread, or omit them from the rest
  type, so callers cannot override them. `rel` may be overridden only if you
  have a reason — simplest is to force both.
- No `onClick` handling, no `preventDefault`, no `openExternal` call. Add a
  short doc comment explaining that `attachWindowOpenHandler` in
  `electron/window.ts` turns `target="_blank"` into `shell.openExternal`.

`src/components/ui/Link/Link.module.css`:

```css
.link {
  cursor: pointer;
  -webkit-app-region: no-drag;
}

.inline {
  color: var(--accent);
  text-decoration: none;
}

.inline:hover {
  text-decoration: underline;
}

.plain {
  color: inherit;
  text-decoration: none;
}
```

`.claude/rules/ui-components.md` — add a bullet after the Buttons bullet:

```
- Links to external URLs: Use `<Link>` from `ui/Link/Link` — never `<Button>` + `openExternal`, and never `<a href="#">`. It opens http(s) URLs in the default browser via Electron's window-open handler.
```

Note: `knip` runs in `pnpm test` and flags unused exports. This ticket's
component will be unused until ticket 2 lands; that is expected — do not add a
fake usage. Run `pnpm exec tsc --noEmit` and `pnpm lint` (not `pnpm test`).

Before starting, check `git status`. If `src/components/sidebar/PrPopover.module.css`
has an uncommitted `white-space: normal` change, leave it alone — ticket 2
handles that file.

## Files to touch
- `src/components/ui/Link/Link.tsx` — new component
- `src/components/ui/Link/Link.module.css` — new styles
- `.claude/rules/ui-components.md` — add the Link rule
