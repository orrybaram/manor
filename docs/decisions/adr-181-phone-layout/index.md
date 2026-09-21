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

# ADR-181: The phone layout — one leaf at a time

ADR-178 slice 4. Reading ADR-178 D1, D5 and D9 first is assumed; ADR-179 D3
(the per-renderer viewport) is the state this ADR presents, and ADR-180 is why
a browser can drive everything the desktop can. The vocabulary is in
`CONTEXT.md` (**Viewport**, **Winsize owner**, **Follower**, **Detached
window**).

## Context

After slice 3 a paired `full` browser reaches every host feature the desktop
does. On a PC that is the finished article. On a phone it is the desktop's
grid shrunk to 390 pixels: a sidebar that eats the screen, split panes a
dozen columns wide, a tab strip of unreadable truncations, and resize dividers
nobody can grab with a thumb. ADR-178 D9 settled what a phone should see
instead — walk the shared layout one leaf at a time — and D10 scheduled it as
this slice.

### What exists

Almost nothing responsive. `src/` has two `@media` rules, both unrelated
(`prefers-reduced-motion` in the palette; the remote client's own
stylesheet), no `matchMedia`, no breakpoint, and no gesture library. Radix
Dialog is already a dependency and can carry a drawer and a sheet.

### The invariant a phone layout must not break

`App.tsx` keeps **every** workspace's `PanelLayout` mounted in one positioned
stack. Inactive workspaces are only hidden, never unmounted or re-parented,
"so their terminals keep the exact pixel box the active workspace has. Any
geometry difference here resizes the PTY on every workspace switch, and a
SIGWINCH makes full-screen TUIs repaint their frame into the scrollback".
That is ADR-163/164/165's bug, and `src/lib/tab-styles.ts` is how the rule is
kept: each tab and workspace is an absolutely-positioned layer over the same
box, and only `visibility` changes — with the visible layer set to `inherit`
so a visible tab inside a hidden workspace does not paint itself back in.

A phone layout that mounted only the pane on screen would remount a terminal
on every pane switch: a `pty.create` and `pty.detach` per tap, a snapshot
restore each time, and — for a pane no desktop is watching — a winsize
change per switch.

### The state is already there

ADR-179 D3 made the viewport per renderer: `activePanelId`,
`selectedTabIds[panelId]`, `focusedPaneIds[tabId]` (`src/lib/layout/viewport.ts`),
persisted by a browser in `localStorage`. "Which pane is this phone showing"
is *exactly* active panel → selected tab → focused pane. The phone needs no
new state; it needs a way to present the state it has.

### The split trees are recursive

`PanelLayout` → `SplitPanelLayout` → `PanelLayout` for panels, and
`PaneLayout` → `SplitLayout` → `PaneLayout` for panes. Each split node renders
its two children side by side with a ratio and a drag divider. That shape is
what lets a phone view keep every terminal's identity: change how a split
node lays out its children, not which children it renders.

## Decision

**D1 — Phone mode is a layout mode of the existing tree, not a second tree.**
In phone mode each split node — `SplitPanelLayout` and `SplitLayout` — keeps
its element structure and child order and renders its two children as
stacked `tab-styles` layers over the full box instead of a flex split. The
visible child is the one that *contains* the viewport's focus: the active
panel for a panel split, the focused pane for a pane split. Recursively only
the path to the focused leaf is visible, every pane of the workspace shares
one box, and **switching panes changes no terminal's geometry and remounts
nothing**. Dividers are not rendered. Entering or leaving phone mode is a
geometry change — the same as resizing the window is today — and nothing
more.

**D2 — The breakpoint is width, in every renderer but a detached window.**
Below ~768 px a renderer is in phone mode: a browser on a phone, and the
desktop window dragged narrow, which is ADR-178 D1's "the desktop gets the
responsive pass for free". A detached window (ADR-179 D4) is excluded — it is
often narrow on purpose and already shows one claimed tab with no chrome.
One hook, `useLayoutMode()`, owns the decision (`matchMedia` plus
`isDetached`) and writes `data-layout="phone" | "desk"` on `.app` — and, for
CSS that lives outside the app's own tree, on `<html>` too (D5) — so CSS and
components read one answer.

**D3 — Phone chrome.** A top bar (the drawer toggle, the workspace name, the
pane-switcher button, the palette button); the active panel's `TabBar` as a
strip under it; the pane full screen beneath; the `StatusBar` hidden. The
**sidebar** becomes a drawer (a Radix Dialog side sheet) that closes when a
workspace is chosen. The **pane switcher** is a bottom sheet listing the
active workspace's panels → tabs → panes, with each pane's agent dot, and a
tap sets the viewport through the existing `focusPanel` / `selectTab` /
`focusPane` actions.

**D4 — No swipe.** ADR-178 D9 named swiping between panes. It collides with
follower mode (ADR-178 D5), which pans a terminal wider than the phone
sideways — the same gesture would mean two things on the one surface where
both matter most. The tab strip and the pane switcher are the only ways to
move. This departs from D9 on purpose.

**D5 — The command palette is the phone's command surface.** The palette
button in the top bar opens it full screen at phone width. Every pane action
that has no touch idiom — split, close, move, detach — is already a palette
command and stays reachable there; drag-to-split, drag-tab and detach-by-drag
are disabled in phone mode rather than half-working under a thumb. Radix
context menus open on long-press, so the pane menu comes along. The audit this
decision calls for found one gap and one deliberate absence: "Move Tab to Next
Panel" existed only in the tab's context menu, so a phone had no way to move a
tab at all, and is now also a palette command (`move-tab-to-next-panel`);
detach was already excluded from the web palette (`NATIVE_ONLY_COMMANDS`),
which matches "what stays deliberately out" below rather than being a miss.

The palette is a Radix `Dialog.Portal`, mounted under `<body>` and never
inside `.app` — so phone CSS keyed off `.app[data-layout="phone"]` could never
match it, and the palette opened on a phone as the desk's fixed 620 px
centered card, hanging off both edges of a 390 px screen, with a 14 px input
that makes iOS Safari zoom on focus. The width assertion in the E2E ticket
*passed* anyway, because 620 px is still greater than 380. `useLayoutMode` now
mirrors the mode onto `<html data-layout>` as well as `.app`, and every
portaled phone rule keys off `:root[data-layout="phone"]` instead
(`src/hooks/useLayoutMode.ts`, `CommandPalette.module.css`). The rule this
teaches: **phone CSS for anything portaled keys off `:root`, never `.app`.**

**D6 — Typing is the native keyboard into xterm.** Tapping a terminal focuses
xterm's own textarea synchronously inside the touch, which is what makes iOS
raise the soft keyboard; the textarea gets `autocapitalize="off"`,
`autocorrect="off"` and `spellcheck="false"`. **The soft keyboard never
resizes the terminal**: the phone shell is sized to the large viewport
(`100lvh`), not the visual one, so opening the keyboard changes no row count
and sends no SIGWINCH, and the browser's native scroll-into-view keeps
xterm's textarea — which sits at the cursor — above the keyboard. There is no
composer and no extra key row. A phone keyboard has no Esc, Tab or Ctrl, so
**from a phone you cannot interrupt an agent or answer a TUI prompt that
needs them**; that is the accepted cost of this choice, stated here so it is
never mistaken for a bug.

**D7 — A PC browser keeps the desktop keybindings, minus the ones it cannot
have.** `Cmd+W`, `Cmd+T` and `Cmd+N` are the browser's before the page ever
sees them. `platformDefaults()` in `src/lib/keybinding-defs.ts` gains a `web`
variant that leaves those three commands unbound (they stay in the palette
and the menu), and the keybindings page marks a browser-reserved chord as
such rather than showing a shortcut that will close the tab. The match is on
the **key combo**, via `BROWSER_RESERVED_COMBOS`, not on a fixed list of
command ids — Manor binds `close-pane` to `Cmd+W`, not `close-tab` (that one
is `Cmd+Shift+W`), so the correct fix strips whichever commands actually land
on the reserved chords (`close-pane`, `new-tab`, `new-agent` by default, or
whatever a user has rebound onto them), rather than hard-coding a command that
happens to be wrong.

The ticket that built this also shipped, then fixed, a regression: it passed
a `"web"` platform string meaning "Mac-style," handing Windows and Linux
browsers `⌘` shortcuts they cannot type. The fix makes "in a browser"
orthogonal to the OS — `platformDefaults(platform, { inBrowser })`, where
`platform` alone still decides ⌘ versus Ctrl. The lesson: a platform string
must describe one fact, not two folded together.

### What stays deliberately out

- **Swipe** (D4), a **composer** and a **special-key row** (D6). The key row
  is the obvious follow-up if the missing Esc/Ctrl bites; it is a small
  component over `pty.write` and nothing in this ADR precludes it.
- A different layout for tablets. Above 768 px is the desk layout.
- Offline, installable-PWA behaviour for the web app. The remote client
  (ADR-161) already does that; the web app is a tab.
- Anything the desktop-in-a-browser cannot mirror at all (ADR-178's list):
  webview panes, native menus, detach. Phone mode inherits those empty states
  unchanged.

### Checked by hand, not by tests

No agent in this ADR could launch Electron with a real window or hold a real
phone, so the following are recorded as **things to verify on a device**, not
as tested:

- On a narrow macOS desktop window: the phone top bar clears the traffic
  lights (`--traffic-light-inset`), the bar drags the window, and its own
  buttons still click through the drag region.
- The drawer on a real phone: it opens, a tap outside it closes it, focus
  returns to the toggle afterward, and ~85% width feels right.
- On iOS Safari and Android Chrome: (1) a tap on a terminal raises the soft
  keyboard; (2) the keyboard opening does not resize the terminal or repaint a
  full-screen TUI's frame into the scrollback; (3) a long-press opens the pane
  menu under a real finger; (4) a vertical drag scrolls scrollback; (5) a
  horizontal drag pans a follower wider than the phone.

Playwright proves the focus call, the textarea's attributes and the viewport
meta tag (`phone.spec.ts`) — not that a real soft keyboard behaves as D6
predicts.

### Follow-ups

Listed so they are not lost, not fixed here:

- `panelTreeContains` / `paneTreeContains` (`src/lib/layout/panel-tree.ts`,
  `pane-tree.ts`) overlap the pre-existing `hasPanelId` / `hasPaneId` — thin
  wrappers that also accept a null id. Collapse them when next touched.
- The palette's detail and stats views (`.detailLayout`'s `1fr 220px` grid,
  `.statsTiles`' four columns in `CommandPalette.module.css`) were not
  redesigned for a phone and are cramped at 390 px.
- "Reopen Closed Pane" (`reopen-pane`) stays keybinding-only — it is not in
  the command palette, so a phone with no keybinding bound to it has no way to
  reach it at all.

## Consequences

**Better.** A phone gets the tabs the desk left open, one pane at a time, with
every host feature one palette search away — "check on my agents from
anywhere" with the same layout, not a second one. No terminal remounts on a
pane switch, so a phone flicking between agents costs nothing and a follower
never moves anybody's winsize. The desktop window becomes usable narrow. No
new state, no new store, no new dependency.

**Harder.** Every split component now has two layouts, and the one that is
not on screen during desk development is the one most likely to rot — which
is why the E2E ticket asserts identity (no remount) and not just pixels.
Touch hit-targets and a full-screen palette are a design pass the desk layout
never needed.

**Risks.** Two, both named so they get tested rather than discovered.
*The soft keyboard.* D6's "never resize" relies on native scroll-into-view
of xterm's textarea; iOS and Android differ, and Playwright cannot raise a
real soft keyboard, so part of this is verified by hand on a device.
*Mode switches are resizes.* Rotating a phone, or dragging the desktop window
across 768 px, re-lays every pane of the workspace at once; for a pane this
renderer owns the winsize of, that is a SIGWINCH per pane. It is the same
event as resizing the window today, and the debounce in `useTerminalResize`
applies — but it now happens at a threshold, where people will hover.

**Not decided here.** A tablet layout. Swipe, if a later measurement shows
the pan collision can be resolved. Whether the special-key row ships.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
