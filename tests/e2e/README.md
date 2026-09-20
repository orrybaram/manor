# E2E Tests (Playwright)

End-to-end tests for Manor, driving the packaged renderer through Playwright's
`_electron` launcher.

## How to run

```bash
# Build the app (renderer, electron, and the remote client) and run everything
pnpm test:e2e

# One file, against whatever is already built
pnpm exec playwright test tests/e2e/smoke.spec.ts

# The remote-control flow, with a build first / without one
pnpm test:e2e:remote
pnpm e2e:remote

# The web app, with a build first / without one
pnpm test:e2e:web
pnpm e2e:web
```

`pnpm test:e2e` runs `pnpm build` first, which produces `dist-electron/main.js`
**and** `dist-electron/remote/` — the phone client the remote-control listener
serves. Running Playwright directly skips that, which is what you want while
iterating on test code and not on app code.

Useful environment variables:

| Variable                   | Effect                                                                                                                                         |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `MANOR_E2E_LOG=1`          | Forward the launched app's stdout/stderr into the test output. The app is a separate process, so this is the only way to see what main logged. |
| `MANOR_E2E_HEADED=1`       | Put the run on screen: the app's windows are shown, it gets a dock icon, and the browser that plays the phone is not headless.                  |
| `MANOR_E2E_HOLD=<seconds>` | Pause the remote-control test at the point where a phone is paired and live, so you can drive both by hand.                                    |
| `MANOR_E2E_VIDEO=1`        | Record a video of every app window into `tests/e2e/artifacts/video/`. Set it to a path to record there instead. Off by default.                |

`pnpm e2e:remote:watch` is those last two together.

## Runs stay out of your way

The suite drives the real app on your own desktop, so by default it launches
it with `--manor-unattended` (`electron/unattended.ts`): windows are created
hidden, the dock icon is hidden so the app can never become the active one,
and native notification banners and their sound are suppressed. Playwright
talks to the renderer over CDP, which never needed a window on screen — so a
run no longer steals focus mid-keystroke or covers what you were doing.

Hidden windows would normally be backgrounded by Chromium (throttled timers,
no frames), which would turn anything driven by rAF into a hang rather than a
failure, so the mode also turns renderer backgrounding off.

Set `MANOR_E2E_HEADED=1` when you actually want to watch a run.

## Fixtures

Import `test` and `expect` from `./fixtures` (not from `@playwright/test`). The
custom fixture provides:

- `app` — the running `ElectronApplication`.
- `window` — the first renderer `Page`, loaded.
- `tempHome` — an isolated `$HOME` with a seeded git repo at
  `<tempHome>/test-project`. Everything the app writes — `manorDataDir()`,
  `~/.manor`, the daemon socket, worktrees — resolves inside it, so runs cannot
  see each other or the real installation.

The app's Electron `userData` (localStorage, session storage) is pointed at
`<tempHome>/user-data` too. Electron would otherwise put it in
`~/Library/Application Support/Electron` regardless of `HOME`, where one run
sees what the last one persisted.

The launched app's environment is scrubbed of `MANOR_*` and `ZDOTDIR`. A run
started from a terminal _inside_ Manor would otherwise inherit that app's
session variables, and the test app's shells would source another
installation's zdotdir out of a home that no longer exists.

## Selector strategy

`data-testid` first: `window.getByTestId("settings-nav-remote")`. Text and role
selectors are fine for things a user reads by name (a button labelled "Send").
Add a test id when a test needs one — not a set of them for tests that do not
exist yet.

Terminal output is **not** in the DOM: xterm renders into a WebGL canvas.
Observe a pane through `helpers/terminal.ts` (the daemon's scrollback file) or
`helpers/local-api.ts` (the app's own control surface) instead.

## Keyboard navigation (ADR-175)

`keyboard-navigation.spec.ts` checks that the whole app works without a
pointer. After boot, every interaction in it is a key press. It never calls
`click()`, so don't add one to make a test pass. The only exception is setup
that has no key of its own, such as making a popout through the application
menu with `app.evaluate`. The PR badge's keyboard test lives in
`sidebar-pr-tweaks.spec.ts`, because that file has the fake `gh`.

The app keeps this selector contract for the suite:

| Selector                                                              | Meaning                                                                                                                       |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `[data-focus-region="sidebar\|tabbar\|pane\|statusbar"]`              | Root of a region that F6 / Shift+F6 cycles through. The test reads the region that holds focus from `activeElement`.          |
| `[data-sidebar-row]`                                                  | Every row in the sidebar that can take focus (Home, project headers, workspace rows, folder headers). One has `tabindex="0"`. |
| `home-row`, `project-header`, `workspace-item`                        | Sidebar rows. The active workspace row has `aria-current="true"` and `data-workspace-path`.                                   |
| `role="tablist"` / `role="tab"` + `aria-selected`, `tab`, `tab-close` | The tab bar, with a roving tabindex. The "+" button is `aria-label="New tab"`.                                                |
| `settings-nav-<section>`, `[data-settings-section]`                   | Settings navigation and the sections it shows.                                                                                |
| `[role="menu"]`                                                       | An open Radix context menu (opened with Shift+F10 or ⌘.).                                                                     |
| `xterm-helper-textarea` has focus                                     | The terminal holds the keyboard.                                                                                              |

Focus polls use a short timeout (`FOCUS`, 3 s). A key pressed right after a
focus move has to land on the new target, so a flake here is usually an app
bug: focus deferred by a frame, or a re-render that drops focus. Fix it in the
app, not with a `waitForTimeout`. To check that a fix holds, run the spec with
`--repeat-each 10`.

### The pointer-only sweep

`no pointer-only controls` walks the main window, Settings and the
notifications popover. It fails on any visible element with `cursor: pointer`
that can't take focus and isn't inside something that can. A `tabindex="-1"`
element passes only as a member of a roving group (`[data-sidebar-row]`,
`[role="tab"]`), and a `<label>` passes when its control can take focus. If
the sweep reports a new clickable `div`, give it a real `Button` or a
keyboard handler plus `tabIndex`. Don't widen the sweep's exemptions.

## The remote-control harness (ADR-161)

`remote-control.spec.ts` drives the whole feature: a live session in the app, a
device paired through Settings, and the phone client in a real browser talking
to the authenticated listener over loopback.

The helpers it stands on:

- **`helpers/fake-agent.sh`** — a stand-in agent CLI. Manor does not learn about
  a session by watching a process: an agent reports its own lifecycle to the
  hook endpoint, and the relay turns those events into the agent rows the phone
  renders. So the fake agent speaks that hook protocol using the
  `MANOR_HOOK_PORT` / `MANOR_PANE_ID` the pty layer gives it. It parks in
  `requires_input` — the state the feature exists to surface — echoes anything
  sent to it, and reads its input non-canonically, the way a real harness does,
  because a send arrives as an ESC interrupt followed by the text and a bare CR.
  Send it `FAKE_AGENT_HUSH` and it ends the turn without re-arming the prompt,
  which is the only way to park a session in `responded`. `fake-agent.ts`
  exports its path and the strings it prints.
- **`helpers/terminal.ts`** — typing into a pane and reading the daemon's
  scrollback back out.
- **`helpers/local-api.ts`** — the app's unauthenticated loopback surface
  (`WebviewServer`), for state the DOM does not hold, and as an independent
  witness that a send reached the pty rather than only the view that asked for
  it. Its response types are the app's own, imported rather than re-declared.
- **`helpers/settings.ts`** — enabling the listener, reading back the address it
  bound, pairing a device through the real dialog.
- **`helpers/phone.ts`** — the client in a phone-shaped Chromium context, with
  its console and any failed request captured.
- **`helpers/filmstrip.ts`** — numbered screenshots into
  `tests/e2e/artifacts/<run>/`. A run is reviewable afterwards without having
  watched it happen.

Nothing in the flow reaches inside the app to fabricate state. The session comes
from an agent reporting itself, the token comes from the pairing dialog, and the
client knows nothing but an address and a bearer token — which is the whole
claim the feature makes.

### Why the agent is started by typing

The session is started by typing the fake agent's path into a terminal pane
rather than with Cmd+N. Cmd+N consumes Manor's prewarmed session, which boots
the project's agent command _before_ the pane exists — so its agent row is
created with no project and no name — and the prewarm that replaces it keeps
running the same agent in the background. Typing into a pane that is already on
screen gives the hook relay its context the first time, and keeps the test off
a race it would otherwise have to retry through.

### Things this harness knows about, on purpose

- **The prewarmed session shows up as a session.** Manor keeps a warm pty with
  the agent command already injected, so that agent reports a lifecycle too and
  earns an agent row — no project, no pane in the layout, name is just a uuid. It
  is visible on the phone. Tests pick their session by intersecting `GET /agents`
  with `GET /panes` rather than taking the first row.
- **The detail view does not follow a session.** Scrollback is read when a
  session is opened and once immediately after a send, which is too early to
  catch the reply; the live stream updates the list, not the open transcript.
  The test taps the client's own Refresh button rather than waiting.
- **A name that lands after the client connected never reaches it.** The stream
  carries status transitions only, so tests wait for the agent to be named before
  the phone loads.
- **Push is not exercised.** Web Push needs a real push service, so the tests
  cover the live-stream path and leave the notification itself untested.

## The web app (ADR-178)

`web-app.spec.ts` proves slice 1's tracer bullet: a browser on a PC opens
`/app`, pairs at `full`, and drives a live terminal over the WebSocket bridge
— through the real listener, the real `dist-electron/web/` bundle and the real
daemon, the same discipline as the remote-control harness above.

The web app *is* the desktop renderer (ADR-178 D1), so once
`helpers/phone.ts`'s `openWebApp` has loaded it, it shares the desktop's test
ids and its "terminal draws into a WebGL canvas" problem — `paneText` in the
spec reads a pane's grid through `window.__manorTerminals`
(`src/lib/terminal-registry.ts`), the same seam
`claude-resize-duplication.spec.ts` uses for the desktop window, because the
browser page runs the identical component. `helpers/phone.ts` also exports the
more general `openClient(url, { viewport })` that `openPhoneClient` and
`openWebApp` are both built on, for anything future that needs a third shape.

`terminal-follower` (`TerminalPane.tsx`) is the D5 affordance: it appears in
the browser exactly when the desktop still has the pane mounted, and the
spec's whole "the desktop owns the winsize" assertion is watching for it plus
the daemon's `cols` refusing to move while the browser's own viewport does.
