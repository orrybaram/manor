---
type: adr
status: proposed
database:
  schema:
    status:
      type: select
      options: [todo, in-progress, review, done]
      default: todo
    priority:
      type: select
      options: [critical, high, medium, low]
    assignee:
      type: select
      options: [opus, sonnet, haiku]
  defaultView: board
  groupBy: status
---

# ADR-173: A shared Link component for opening URLs

## Context

The PR popover's title ran off the edge of the popover. It was rendered as a
`<Button variant="ghost">` whose click handler called
`window.electronAPI.shell.openExternal(pr.url)`, and `Button.module.css` sets
`white-space: nowrap` on every button, so a long title never wrapped.

The wrapping bug is a symptom. ADR-093 gave the app a shared `Button` and the
`ui-components` rule says to use it for interactive UI, but there is no
equivalent for *links*. So every "click this to go to a URL" element picks one
of several hand-rolled shapes:

| Shape | Where |
|---|---|
| `<Button>` + `openExternal` | `PrPopover` title and check rows, `PrCommentCard` "open on GitHub" icon |
| raw `<button>` + `openExternal` | `GitHubNudge` "GitHub CLI" |
| `<a href="#">` + `preventDefault` + `openExternal` | `GitHubIntegrationSection`, `LinearIntegrationSection` |
| `<a href>` + `preventDefault` + `openExternal` | `AboutModal` changelog markdown, `PrCommentCard` comment markdown |
| `<div role="button">` + `openExternal` | `PortBadge` external-link icon |

None of these are real links: screen readers announce buttons, there is no
"copy link" context menu, and each copy re-implements the same click plumbing
(and in the button cases inherits button styling that fights inline text).

Electron already has the plumbing a real link needs. Both renderer windows
(`createWindow` and `createDetachedWindow` in `electron/window.ts`) call
`attachWindowOpenHandler`, which routes any `target="_blank"` navigation with
an `http:`/`https:` URL to `shell.openExternal` and denies the in-app popup.
A plain `<a href target="_blank">` therefore opens in the default browser with
no renderer-side handler at all.

## Decision

Add `src/components/ui/Link/Link.tsx` (+ `Link.module.css`), following the
`Button` pattern (`React.forwardRef`, spread native attributes, class list
joined from the module).

```tsx
type LinkVariant = "inline" | "plain";

type LinkProps = Omit<
  React.AnchorHTMLAttributes<HTMLAnchorElement>,
  "href" | "target"
> & {
  href: string;
  variant?: LinkVariant; // default "inline"
};
```

- Always renders `<a href={href} target="_blank" rel="noreferrer">`. `target`
  is not overridable: without it a click would navigate the app's own window.
- **No `onClick` → `openExternal`, no `preventDefault`.** The main-process
  window-open handler does the opening, which also makes middle-click and
  Cmd-click behave.
- Variants:
  - `inline` — link inside prose: `color: var(--accent)`, no underline,
    underline on hover. Replaces `.linearLink`, `.nudgeLink`, the markdown
    link styles.
  - `plain` — link as a block/row whose caller styles it (PR title, check row,
    icon link): `color: inherit; text-decoration: none`.
- Callers that live inside click-sensitive parents (Radix popover, sidebar
  row) still pass `onClick={(e) => e.stopPropagation()}` themselves; the
  component does not guess.
- **Scope is http(s) URLs only**, because that is all the window-open handler
  opens. Non-web schemes keep calling `openExternal` directly.

Update `.claude/rules/ui-components.md` to add: "Links to external URLs: use
`<Link>` from `ui/Link/Link` — never `<Button>` + `openExternal`, and never
`<a href="#">`."

### Migrated

- `src/components/sidebar/PrPopover.tsx` — title and `CheckRow` (a row with no
  `url` renders a non-interactive element instead of a disabled button). The
  local `openExternal` helper goes away.
- `src/components/ui/PrCommentCard/PrCommentCard.tsx` — the "open on GitHub"
  icon and the markdown `a` renderer. Local `openExternal` helper goes away.
- `src/components/settings/GitHubIntegrationSection.tsx`,
  `src/components/settings/LinearIntegrationSection.tsx`
- `src/components/sidebar/GitHubNudge.tsx`
- `src/components/statusbar/AboutModal/AboutModal.tsx` — changelog markdown `a`
- `src/components/ports/PortBadge.tsx` — the `div role="button"` icon (the
  context-menu item keeps `onSelect` + `openExternal`; menu items are not links)

### Deliberately not migrated

- `ProjectItem.tsx` "Open in Finder" (`file://`) and `TerminalPane.tsx`
  "Open Privacy & Security" (`x-apple.systempreferences:`) — non-http schemes
  the window-open handler denies.
- `IssueDetailView` / `GitHubIssueDetailView` "open in browser" — a
  command-palette action that also closes the palette and is keyboard-driven.
- `ProjectItem` PR badge `onOpen` — the badge is the popover's trigger.
- Toast actions, notification navigation, menu handlers, terminal link
  handling — not rendered elements.

## Consequences

- The PR title wraps naturally; the `white-space: normal` override added to
  `.prPopoverTitle` as a stopgap is removed.
- Links are announced as links and get the native link context menu.
- One place owns external-link styling and the `target`/`rel` contract.
- **Risk:** `Link` depends on `attachWindowOpenHandler` being attached to every
  `BrowserWindow` that loads the renderer. A future window created without it
  would open links as Electron popups. Nothing guards `will-navigate` on the
  main window either; `Link` never omits `target`, so it is safe, but a raw
  `<a href>` elsewhere would still navigate the app. Hardening the main process
  is out of scope here.
- **Risk:** a non-http `href` passed to `Link` silently does nothing (the
  handler denies it). Documented on the component; not enforced at runtime.
- Clicking a link no longer runs renderer code before opening, so any future
  "close the popover after opening" behaviour has to hang off `onClick`
  without `preventDefault`.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
