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
```

`pnpm test:e2e` runs `pnpm build` first, which produces `dist-electron/main.js`
**and** `dist-electron/remote/` — the phone client the remote-control listener
serves. Running Playwright directly skips that, which is what you want while
iterating on test code and not on app code.

Useful environment variables:

| Variable                   | Effect                                                                                                                                         |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `MANOR_E2E_LOG=1`          | Forward the launched app's stdout/stderr into the test output. The app is a separate process, so this is the only way to see what main logged. |
| `MANOR_E2E_HEADED=1`       | Show the browser that plays the phone. The Electron window is always visible.                                                                  |
| `MANOR_E2E_HOLD=<seconds>` | Pause the remote-control test at the point where a phone is paired and live, so you can drive both by hand.                                    |
| `MANOR_E2E_VIDEO=1`        | Record a video of every app window into `tests/e2e/artifacts/video/`. Set it to a path to record there instead. Off by default.                 |

`pnpm e2e:remote:watch` is those last two together.

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

## The remote-control harness (ADR-161)

`remote-control.spec.ts` drives the whole feature: a live session in the app, a
device paired through Settings, and the phone client in a real browser talking
to the authenticated listener over loopback.

The helpers it stands on:

- **`helpers/fake-agent.sh`** — a stand-in agent CLI. Manor does not learn about
  a session by watching a process: an agent reports its own lifecycle to the
  hook endpoint, and the relay turns those events into the task rows the phone
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
the project's agent command _before_ the pane exists — so its task row is
created with no project and no name — and the prewarm that replaces it keeps
running the same agent in the background. Typing into a pane that is already on
screen gives the hook relay its context the first time, and keeps the test off
a race it would otherwise have to retry through.

### Things this harness knows about, on purpose

- **The prewarmed session shows up as a session.** Manor keeps a warm pty with
  the agent command already injected, so that agent reports a lifecycle too and
  earns a task row — no project, no pane in the layout, name is just a uuid. It
  is visible on the phone. Tests pick their session by intersecting `GET /tasks`
  with `GET /panes` rather than taking the first row.
- **The detail view does not follow a session.** Scrollback is read when a
  session is opened and once immediately after a send, which is too early to
  catch the reply; the live stream updates the list, not the open transcript.
  The test taps the client's own Refresh button rather than waiting.
- **A name that lands after the client connected never reaches it.** The stream
  carries status transitions only, so tests wait for the task to be named before
  the phone loads.
- **Push is not exercised.** Web Push needs a real push service, so the tests
  cover the live-stream path and leave the notification itself untested.
