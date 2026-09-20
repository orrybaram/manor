---
title: The web app's stores initialise before the bridge exists
status: in-progress
priority: high
assignee: sonnet
blocked_by: [3]
---

# The web app's stores initialise before the bridge exists

Found while implementing ticket 3, pre-existing since ADR-178 slice 1, and it
has to go before tickets 5–10 or every "does it work in a browser?" check
those tickets make is checking a browser that was already broken.

## The bug

`src/web-main.tsx` does `import App from "./App"` at the top and installs
`window.electronAPI` in its body. Static imports evaluate first, so every
zustand store module is evaluated *before* the bridge exists — and the stores
call the bridge **inside `create()`'s initializer**:
`window.electronAPI?.preferences.getAll()`, `.theme.onChanged(…)`,
`.agents.onUpdate(…)`, and the same shape in the keybindings, stats,
notifications and remote-control stores.

Every one is `?.`-guarded, so nothing throws. They simply never run. In a
browser tab the initial preferences read, the theme subscription, the agent
subscription and their siblings silently do not happen; what works, works
because something later re-reads. `app-store.ts` already papers over exactly
this for its one module-scope call with a `queueMicrotask`.

The desktop escaped it in ticket 3 only because `src/bridge/install-desktop.ts`
is a side-effect module imported before `App` — a static import that runs for
its side effect, which is the one thing that reliably beats another static
import.

## The fix

Give the web the same shape: a side-effect module that installs the bridge,
imported by `web-main.tsx` before `App`. The complication the desktop does not
have is that the web bridge needs the pairing token, and `web-main.tsx` reads
it out of the URL fragment and renders `NoTokenScreen` / `ForbiddenScreen`
when there isn't one.

Split it: the token read and the bridge install move into the side-effect
module (it can export the token and the two callbacks' state for `web-main`
to render from), while `web-main.tsx` keeps the rendering decision. Whatever
shape you pick, the invariant to hold and to state in the header is: **no
store module is evaluated before `window.electronAPI` is installed.** On the
desktop that is `install-desktop.ts`; do not leave the two entries with
different answers to the same question.

Then remove `app-store.ts`'s `queueMicrotask` workaround if the invariant
makes it dead, and say in the commit that it was a symptom of this.

## Verification

- A test that fails on the old ordering: evaluate a store module with a
  spy-backed `electronAPI` installed by the side-effect module and assert the
  initializer's calls happened. A test that only asserts "it does not throw"
  passes on the bug.
- In a real browser tab against a paired `full` device: the theme applies on
  first paint without a second interaction, and the agents list is populated
  before anything is clicked.

## Files to touch
- `src/bridge/install-web.ts` — new; the token read and the install, as a side effect
- `src/web-main.tsx` — import it first; keep the screen decision
- `src/bridge/install-desktop.ts` — header note that the two entries share the invariant
- `src/store/app-store.ts` — drop the `queueMicrotask` workaround if it is now dead
- `src/bridge/__tests__/install.test.ts` — new; the ordering invariant
