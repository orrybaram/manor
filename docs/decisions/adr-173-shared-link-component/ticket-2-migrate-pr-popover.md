---
title: Migrate PR popover and comment card to Link
status: done
priority: high
assignee: sonnet
blocked_by: [1]
---

# Migrate PR popover and comment card to Link

Replace every click-to-open-URL element in the PR popover and the shared PR
comment card with `<Link>` from `src/components/ui/Link/Link`.

## PrPopover.tsx

1. **Title** — currently:
   ```tsx
   <Button variant="ghost" size="sm" className={styles.prPopoverTitle}
     title="Open this pull request on GitHub"
     onClick={(e) => { e.stopPropagation(); openExternal(pr.url); }}>
     {pr.title}
   </Button>
   ```
   Becomes:
   ```tsx
   <Link variant="plain" href={pr.url} className={styles.prPopoverTitle}
     title="Open this pull request on GitHub"
     onClick={(e) => e.stopPropagation()}>
     {pr.title}
   </Link>
   ```
2. **CheckRow** — when `run.url` is set, render a `<Link variant="plain">` with
   the same `className={styles.prPopoverCheck}`, `title`, children and an
   `onClick` that only stops propagation. When `run.url` is missing, render a
   `<div className={styles.prPopoverCheck} title={run.name}>` with the same
   children (it used to be a disabled button; it should not be interactive).
3. Delete the local `openExternal` helper at the top of the file.
4. Keep the `Button` import — "+N more" / "Show fewer" are real buttons.
5. Update the component doc comment if it mentions rows being buttons.

## PrPopover.module.css

- `.prPopoverTitle`: delete `white-space: normal;` and the "Button is nowrap"
  comment above it. Keep `overflow-wrap: anywhere;` (it breaks a long
  unbroken token such as a URL in a title). `display: block`, `width: 100%`,
  padding, font-size, color, line-height, border-radius stay.
- `.prPopoverTitle:hover:not(:disabled)` → `.prPopoverTitle:hover` (anchors
  have no `:disabled`). Keep `background: none; color: var(--accent)`.
- `.prPopoverCheck`: it previously got `cursor`, hover background, etc. from
  Button ghost. Add what the row now lacks so it looks the same:
  `cursor: pointer` is on `.link` already; add a
  `a.prPopoverCheck:hover { background: var(--surface); }` (matching
  `Button.module.css` `.ghost:hover`). The non-link `div` variant must have no
  hover state.
- Delete `.prPopoverCheck:disabled` (no longer used).

## PrCommentCard.tsx

1. The "Open this comment on GitHub" icon `<Button variant="ghost" size="sm"
   className={styles.action}>` → `<Link variant="plain" href={comment.url}
   className={styles.action} title=... aria-label=... onClick={(e) =>
   e.stopPropagation()}>` with the same `<ExternalLink size={11} />` child.
   The "Send to agent" `Button` stays a Button.
2. `CommentMarkdown`'s `a` renderer → render `<Link variant="inline"
   href={href} title={href} onClick={(e) => e.stopPropagation()}>` when `href`
   is set; if `href` is missing, render `<span>{children}</span>`.
   Remove the `preventDefault` / `openExternal` code.
3. Delete the local `openExternal` helper.

## PrCommentCard.module.css

- `.action:hover:not(:disabled)` → `.action:hover` so it applies to the anchor.
  `.action` needs no other change (it already sets display/size/color). Check
  the Send-to-agent button still uses `.action` and still looks right.
- `.body a` may stay (it sets underline); leave it unless it conflicts.

## Verify

`pnpm exec tsc --noEmit`, `pnpm lint`, `pnpm test` (knip should now be happy
because `Link` is used).

## Files to touch
- `src/components/sidebar/PrPopover.tsx` — title and CheckRow to Link
- `src/components/sidebar/PrPopover.module.css` — drop nowrap stopgap, link hover styles
- `src/components/ui/PrCommentCard/PrCommentCard.tsx` — icon link and markdown links
- `src/components/ui/PrCommentCard/PrCommentCard.module.css` — hover selector
