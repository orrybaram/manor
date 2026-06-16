---
type: adr
status: accepted
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

# ADR-145: Correct Window/Link Targeting & Popup Semantics in Browser Webviews

## Context

Manor embeds web content in browser panes using Electron `<webview>` tags
(`src/components/workspace-panes/BrowserPane/BrowserPane.tsx`, one top-level
`<webview src=...>` per pane). New-window behavior is currently implemented by
**injecting JavaScript into every guest page** that overrides `window.open` and
listens for `target="_blank"` anchor clicks
(`electron/ipc/webview.ts`, `INTERCEPT_NEW_WINDOW_SCRIPT`). The injected script
relays a URL back to the renderer over a `console.log` marker
(`__manor_new_window__:`), which becomes a `webview:new-window` IPC message, which
calls `addBrowserTab(url)` (`src/store/app-store.ts:647`).

This was introduced in commit `41bd1a4` *"feat: open target=\"_blank\" links in
new browser tabs"* — a deliberate but **narrow** feature (just `_blank` → new tab).
The `window.open` override was bundled in as a catch-all written as
`function(url){...}`, **dropping the second argument entirely**. ADR-119 later
moved this code verbatim into `electron/ipc/webview.ts` without redesign. No ADR
governs the targeting semantics.

Two concrete bugs result, plus a class of unhandled cases:

1. **`window.open(url, '_parent')` (and `_self`, `_top`) open a new tab instead of
   navigating in place.** The injected override never reads the target, so every
   `window.open` call — regardless of target — is flattened to "open a new manor
   tab." Per the HTML spec these targets should navigate an *existing* browsing
   context, not create one.

2. **`window.open` from inside an `<iframe>` is silently dropped.** The intercept
   script is injected via `executeJavaScript`, which runs in the **main frame
   only**. Sub-frame `window.open` calls bypass the override and fall through to
   Electron's native path; because the `<webview>` has no `allowpopups` attribute,
   the native path blocks the open with no feedback.

3. **No principled handling of popups, named targets, or opener-based
   communication.** The override returns `null`, so any site relying on the
   `WindowProxy` handle returned by `window.open` (OAuth/SSO popups, payment flows,
   `postMessage`-coordinated auth) breaks: there is no handle to `postMessage` to,
   no `window.opener` on the openee, no `window.close()`, and no named-target reuse.

### The product question this ADR must answer

Manor uses **per-project tabs** as its primary surface, so "new window → new tab"
is the natural mapping for ordinary link navigation. But popups are not all
ordinary navigation. There are two distinct intents hiding behind `window.open`:

- **Navigation-style opens** — `target="_blank"` links, cmd/middle-click, plain
  `window.open(url)` whose return value is ignored. The user just wants the page
  somewhere new. **A manor tab is the correct home.**
- **Communicating popups** — `window.open(url, name, "width=…,height=…")` used by
  OAuth/SSO/payment flows. The opener *keeps the handle* and relies on a live
  relationship: `popup.postMessage()`, `popup.closed`, `window.opener`,
  `window.close()`, and reuse of the named context.

**The hard constraint:** a manor tab is a *separate* top-level `<webview>` —
a separate `WebContents` with its own frame tree. Chromium only wires up
`window.opener` / a live `WindowProxy` / synchronous cross-document scripting when
the new context is created through the **native window-open path within a
compatible process**. There is no way to retrofit that relationship onto a manor
tab created out-of-band over IPC. Therefore **"popup → manor tab" inherently
cannot preserve opener communication.** Routing OAuth popups to tabs will keep
breaking those flows no matter how we patch the injected script.

This means correctness requires *routing by intent*, which in turn requires the
metadata only Electron's **native** open path exposes — `disposition`,
`frameName`, and `features` — none of which the injected-JS approach can see.

## Decision

**Replace the injected-JS interception with Electron's native
`setWindowOpenHandler` on the guest `WebContents`, and route opens by intent.**
Remove `INTERCEPT_NEW_WINDOW_SCRIPT` and its console-message listener entirely.

### 1. Enable the native open path

Add the `allowpopups` attribute to the `<webview>` in `BrowserPane.tsx`. Without
it, the guest's `window.open` is blocked before `setWindowOpenHandler` ever fires
(this is the root of bug #2). With it present, **we control every open decision in
the handler** — `allowpopups` does not mean "allow everything," it means "let the
open request reach our handler."

### 2. Register `setWindowOpenHandler` in `webview:register`

In `electron/ipc/webview.ts`, where we already attach context-menu / escape /
console listeners to the guest `wc`, register a window-open handler. It receives
`{ url, frameName, features, disposition }` and routes:

| Signal | Meaning | Action |
|---|---|---|
| `disposition: foreground-tab` / `background-tab` (plain `_blank` link, cmd/middle-click, `window.open` w/o features) | navigation-style | `{action:'deny'}` + relay `webview:new-window` → manor tab. Pass `background` so cmd-click does not steal focus. |
| `disposition: new-window` **and/or** a `features` string present (`width`/`height`/`popup`) | communicating popup (OAuth/SSO/payment) | `{action:'allow', overrideBrowserWindowOptions:{…}}` → real managed child window with `window.opener`, `postMessage`, `closed`, `close()`, named reuse all wired natively. |
| `_self` / `_parent` / `_top` / in-page nav | same/ancestor frame navigation | **Never reaches `setWindowOpenHandler`** — these are `will-navigate`, handled natively by the guest. Removing the JS override is what fixes bug #1. No manor code needed. |

The exact `disposition` values Electron emits for each gesture on a `<webview>`
must be confirmed by a short spike before finalizing the routing table (see
Ticket 1 acceptance criteria) — the table above is the intended mapping, not an
assumed fact.

### 3. Managed child window for communicating popups

For the `allow` branch, create an owned child `BrowserWindow` (parented to the
main window) so OAuth/SSO/payment flows work end-to-end. Track child windows and
destroy them when the originating pane is unregistered or the main window closes.
This is the only way to preserve the Chromium opener relationship the flows depend
on. (`overrideBrowserWindowOptions` lets us size/style it; `did-create-window`
gives us the child `WebContents` for tracking and for applying the same external-
link policy as the main window.)

### 4. Frame-to-frame & tab-to-tab communication — explicit semantics

- **Frame-to-frame** (iframe targeting `_parent`/`_top`, or a named sibling frame
  *inside the same page*): stays entirely within the guest's own frame tree.
  Manor must **not** intercept it or escalate it to a tab — naively treating
  `_parent` as "navigate the webview's top URL" would break legitimate
  iframe→parent navigation. Native pass-through handles this correctly.
- **Tab-to-tab** (manor tab → manor tab): **not supported, by design.** Independent
  `<webview>` tabs have no opener relationship; `window.opener`, handle
  `postMessage`, and named-target reuse across tabs are not available. This is the
  status quo and the documented limitation. Sites that genuinely need it get a
  real child window via the popup path (#3), not a tab.

### 5. Thread `disposition` through the existing IPC

Extend `webview:new-window` (preload + `electron.d.ts` + `BrowserPane` listener)
to carry a `background` flag, and extend `addBrowserTab(url, { background })` in
`app-store.ts` so `background-tab` opens create a tab without stealing focus.
Default stays foreground for backward compatibility (the image context-menu
"Open Image in New Tab" path and all existing `addBrowserTab` callers keep working
unchanged).

## Consequences

**Better:**
- `window.open(url, '_parent' | '_self' | '_top')` navigates in place (bug #1 fixed)
  — and it's fixed by *removing* code, not adding a special case.
- `window.open` from iframes works (bug #2 fixed) — the native handler fires for
  all frames, not just the main frame.
- OAuth/SSO/payment popups work, with a real opener relationship (new capability).
- cmd/middle-click can open background tabs without focus theft.
- Less injected JS running in every guest page; decisions move to a single typed
  handler with authoritative metadata.

**Harder / risks:**
- Adds a managed child-window lifecycle (creation, tracking, cleanup on pane
  unregister / window close). Leaks here mean orphaned windows.
- `allowpopups` must be paired with a correct handler or it would let guests open
  windows freely — the handler is now load-bearing for security, not just UX.
- Exact `disposition`/`features` values on `<webview>` need verification across the
  Electron version in use; the routing table is intent, pending the Ticket 1 spike.
- Popup *window features* (size/position) are best-effort; manor may normalize them.
- Named-target reuse across manor tabs remains unsupported (documented limitation).

**Open product decision (to confirm at approval):** whether communicating popups
should open as a **real child window** (recommended — preserves opener semantics,
makes OAuth work) or be **forced into a manor tab** (simpler, consistent tab UX,
but knowingly breaks handle-dependent flows). The decision above assumes the
former; Ticket 3 is scoped to it and can be dropped if we accept the limitation.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
