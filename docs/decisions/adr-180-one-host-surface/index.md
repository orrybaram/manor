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

# ADR-180: One host surface, two transports

ADR-178 slice 3. Reading ADR-178 D4 and D8 first is assumed; ADR-179 built the
layout half of it. The vocabulary is in `CONTEXT.md` (**Bridge**, **Renderer**,
**Manor server**, **Host**, **Viewer**).

## Context

ADR-178 D8 named the end state: one interface — the shape of
`window.electronAPI` — with the preload as a *migration shim*, not a peer, and
`electron/ipc/` deleted when the last feature has moved. Slices 1 and 2 built
the other side of that bridge and left the desktop where it was. The drift D8
promised to end is, as predicted, briefly worse:

| surface | size | who reaches it |
| --- | --- | --- |
| `electron/ipc/` | 20 modules, 3268 lines, **169** `ipcMain` registrations | the desktop renderer, through 211 preload methods in 26 namespaces |
| `WS_HANDLERS` | 1 table, **35** entries | a paired `full` device, over `/ws` |
| `electron/routes/` | ~100 routes | the CLI, MCP, and a `read`/`send` device |

97 files in `src/` call `window.electronAPI`. Every host-side feature landing
today has to be written twice — once as an `ipcMain.handle`, once as a table
entry — and the second one is the one people forget, which is why the slice-1
table had to grow four times during ADR-178's own tickets (`pty.reset`,
`preferences.set`, `remoteControl.getStatus`, `agents.setPaneContext`), each
time because a browser hit a hole the desktop never had.

### The table already is the shape

`ws-handlers.ts` did the hard part already, and deliberately: each entry calls
a plain function **lifted out of** an `ipcMain.handle` wrapper, over the same
`IpcDeps` the `ipc/` modules get, keeping its `assert*` validation, with both
callers going through it. `ipc/pty.ts` is the template — `ptyCreate`,
`ptyWrite`, `ptyResize`, `ptyReset`, `ptyClose`, `ptyDetach` are exported
functions, and `register()` is six thin `ipcMain.handle` calls around them.
Most of the migration is *finishing that lift* module by module and deleting
the wrapper.

### What is not yet shaped

**The connection.** `WsBridgeServer` owns three things that are not about
WebSockets: the `ns.method` dispatch, the per-connection subscription map, and
the connection registry that `pty-attachments` and the layout origin read. A
desktop window needs all three and none of the socket.

**The event side.** A browser hears about the world through bridge event
frames, fed by `renderer-broadcast.ts` and the PTY stream. A desktop window
hears about it through ~20 distinct `webContents.send` channels, some
per-pane (`pty-output-${paneId}`), some addressed to exactly one window
(`app-command` to the primary, `menu-command` to the focused one,
`worktree:setup-progress` to the window that asked). Broadcast alone does not
cover that: the transport has to be able to address *one* connection.

**The client.** `src/web/ws-bridge.ts` is already a transport-agnostic idea
wearing a WebSocket: a `Proxy` turning `ns.method(...)` into an invoke frame
and `ns.onX(cb)` into a subscribe frame, with `BridgeConnection` holding the
socket, the pending map, the outbox and the reconnect timer in one class.

**`contextBridge` cannot expose a `Proxy`.** It copies the shape it is handed
across the isolated-world boundary; a proxy's dynamic members are not there to
copy. So the desktop cannot simply be handed the same object the browser
builds — the preload has to expose something concrete, and the proxy has to be
built *in the page*, which is where `web-main.tsx` already builds it.

### What can never leave the preload

`<webview>` and its 27 methods (ADR-052/056/058/158), detach-to-window
(ADR-156/157/179 D4), the native menu (ADR-170), native dialogs, `shell`
(open-in-editor, reveal in Finder — ADR-050), the machine clipboard, and the
updater. `src/web/unavailable.ts` already names exactly this set, and names it
as a design fact rather than a gap. These keep real preload methods and their
`electron/ipc/` modules; "delete `electron/ipc/`" has always meant "delete
everything in it that is not about Electron".

## Decision

**D1 — One host surface, one protocol, two transports.** The handler table is
promoted out of `remote-control/` into `electron/bridge/`: `handlers.ts` (the
table), `server.ts` (dispatch, connections, subscriptions, audit) and
`transports/{ipc,ws}.ts`. A **connection** is what dispatch knows about a
caller — an id, a caller class, a `send(frame)`, and a subscription map — and
`WsBridgeServer` becomes the thing that makes one out of an authenticated
socket, keeping its hello frame, its close codes and its tier check exactly as
they are. Remote control still owns authentication; the bridge never learns
what a token is.

**D2 — The desktop's transport is one IPC channel, not a loopback socket.**
ADR-178 D8's consequences imagined the desktop dialling
`ws://127.0.0.1:<port>`. It is not worth what it costs: an always-on local
listener needs its own authentication because *any web page* can open a
WebSocket to loopback, a token has to reach the renderer through the preload
anyway, first paint starts waiting on a socket, and the PTY stream leaves
Electron's structured clone for JSON over TCP. Instead the desktop speaks the
*same frames* over `bridge:invoke` / `bridge:subscribe` / `bridge:unsubscribe`
/ `bridge:event`, one connection per renderer window, id = `webContents.id`.
One table, one protocol, two transports — which is what D8 was actually for.
Attaching the desktop to a *remote* host (ADR-178 D7) is then a matter of
handing the renderer the WS transport it already ships, not of inventing one.
This amends ADR-178's consequences; D8's rule — no new preload method — stands
and now has teeth.

The IPC transport answers only senders it recognises: a frame whose
`event.sender` is not one of `getRendererWindows()` or a registered detached
window is dropped. A `<webview>` guest is not a renderer window, and this is
the sentence that says so.

**D3 — The page builds `window.electronAPI`.** The preload exposes one
concrete object, `window.manorHost`: the synchronous facts it reads off its
own argv (`platform`, `rendererId`, `isDetached`, `detachedWindowId`, `claim`,
`env`), an `invoke`/`subscribe` pair, and the **native** namespaces that stay
(`webview`, `window`, `menu`, `dialog`, `shell`, `clipboard`, `updater`).
`src/bridge/` holds the client — `client.ts` (the proxy, the pending map, the
outbox, the subscription registry, lifted out of `src/web/ws-bridge.ts`) and
`transports/{ipc,ws}.ts` (the socket, the reconnect and the hello stay in the
WS one). `src/main.tsx` installs the proxy over the IPC transport before it
renders, exactly as `web-main.tsx` does over the WS one, and the proxy falls
through to `manorHost`'s native namespaces. None of the 97 calling files
changes.

**D4 — Caller class, and a table that says what it refuses.** Every connection
is `local` (an Electron renderer window, authenticated by being one) or
`device` (a paired `full` device). A table entry may be marked `LOCAL_ONLY`.
The list grew past what was scoped here as implementation found more of the
same shape: `keybindings.set/reset/resetAll/runInMainWindow`,
`remoteControl.setEnabled/pair/revoke/startTunnel/stopTunnel`,
`viewport.load/save`, the prewarm pair (`pty.consumePrewarmed`/
`updatePrewarmCwd`), `appCommands.result` (ticket 6 — addressed to the
primary window only, so no device has anything to answer) and
`linear.connect` (ticket 10 — the one method whose argument is a credential).
A device calling one gets `unavailable:web`, which is what it gets today —
the difference is that it is now a decision in the table rather than an
absence, and `allowlist.test.ts` asserts the list instead of asserting
silence. What was not decided here and had to be corrected mid-implementation:
a refused `LOCAL_ONLY` call originally left no audit line at all, on the
reasoning that nothing had happened; it does now, as `rejected`/403 (`6bd3a3d`,
ticket 13), with a null target for a method whose first argument is a secret
— see "What implementation found" below. Everything else on the table is
reachable by a `full` device, which is ADR-178 D3 as written. `MUTATING` and
the audit log are otherwise unchanged, and a `local` call is never audited:
it is the user at the machine.

**D5 — Events are subscriptions, on both transports.** Every non-native
`webContents.send` becomes a bridge event frame. Broadcasts go through
`renderer-broadcast.ts`, which already exists for exactly this. Per-pane
channels collapse into `pty.output`/`exit`/`cwd`/`resized`/`agentStatus`/
`error` with `key = paneId` — the filtering the WS server already does.
Addressed sends (`app-command`, `app-command-result`, `menu-command`,
`worktree:setup-progress`, `notifications:navigate`, updater progress) become
`server.sendTo(connectionId, frame)`, and "the primary window" resolves to its
connection id. `renderer-bridge.ts` stops reaching for a `BrowserWindow` to
`send` on.

**D6 — A pane's viewers are connections.** `pty-attachments.ts` stops
distinguishing `{kind:"desktop", id:number}` from `{kind:"bridge", id:string}`
and tracks connection ids with their caller class. Ownership keeps ADR-179
D6's rule with one repair: `local` outranks `device`, and *among equals the
most recent attach wins*, so two desktop windows on one pane stop fighting
over the winsize instead of last-caller-wins. `createShaped`'s decoration runs
for every caller, so a local viewer that is not the owner becomes a follower
through the same code path a browser does — `onWinsizeOwner` stops being a
no-op on the desktop.

**D7 — The surface is checked at compile time.** `src/electron.d.ts` stays the
contract. A type-level exhaustiveness check asserts that every method of
`ElectronAPI` is placed. This paragraph originally named three sets — the
handler table, the native preload namespaces, `LOCALLY_SERVED` — and shipped
with four. Ticket 12 found the fourth while building the check: a `ns.onX(cb)`
is not a table entry, it is a `subscribe` frame and an event somebody has to
publish (D5), and the first three sets left all twenty-five non-native
subscriptions unplaced — exactly the hole the Risks section below already
named ("a `webContents.send` that nobody converts is a feature that quietly
stops updating"). `SUBSCRIPTIONS` is that fourth set, and adding a listener to
`ElectronAPI` now means naming the event it hears. Adding a method to the
interface without placing it is a type error, not a runtime `unavailable:web`
discovered by whoever opened a browser — but only since ticket 15 made
`pnpm typecheck` run both tsconfigs and put it ahead of `pnpm build` in the
gate. Before that, nothing in this repo ran `tsc` at all: the check existed,
fired correctly in an editor, and ran nowhere a contributor's green build
would see it. D7's promise — "a type error, not a runtime one" — became true
on the day ticket 15 landed, seven tickets after this one shipped the check
itself; say so rather than let the two dates blur into one. This is the
mechanism that keeps the drift dead once this ADR closes it.

**D8 — What gets deleted.** `electron/ipc/`'s `agents.ts`,
`branches-diffs.ts`, `integrations.ts`, `layout.ts`, `notifications.ts`,
`ports.ts`, `processes.ts`, `projects.ts`, `pty.ts`, `remote-control.ts`,
`stats.ts`, `theme.ts`, `viewport.ts` and most of `misc.ts` lose their
`register()`; their lifted functions move to `electron/bridge/handlers/` as
the table's implementation. `webview.ts`, `webview-keys.ts`, `window.ts`,
`popups.ts`, `menu.ts` and the dialog/shell/clipboard/updater remnant of
`misc.ts` stay, and are what `electron/ipc/` means from here on. `preload.ts`
goes from 941 lines to the native namespaces plus `invoke`/`subscribe`. It
landed at 494 lines, not the "well under 300" ticket 11 was asked for.
`webview`'s 27 methods are ~250 of those on their own, plus the argv-derived
facts and the bridge-event plumbing `invoke`/`subscribe` need; getting under
300 means splitting `preload.ts` into several files, which ticket 11 judged
correctly to be a different change from this one. Correct the number here
rather than the code. `src/web/ws-bridge.ts` and `src/web/unavailable.ts`
were deleted outright, not kept as a one-release re-export; their callers
(`web-main.tsx`, `src/web/screens.tsx`) import from `src/bridge/` instead.

### What stays deliberately out

- The phone layout (ADR-178 D9, slice 4). This ADR touches no component.
- Attaching the desktop renderer to a *remote* host. D2 makes it a transport
  choice; choosing it is ADR-160/D7's work, and cloud authentication is still
  undecided.
- `electron/routes/` and the CLI/MCP surface. It is a third caller of the same
  managers, not a third copy of the table, and ADR-179 D5 already pointed its
  layout half at the server.
- The remote client (ADR-178 D2) keeps its 16 KB and its allowlist.

## Consequences

**Better.** One place to add a host feature, and a type error if you add it
anywhere else. The 169/35 split becomes one table; `electron/ipc/` shrinks to
the six modules that genuinely need Electron. Every `assert*` validation the
bridge runs now also runs on the desktop's calls, so the two callers stop
having different ideas about what a valid argument is. `onWinsizeOwner` works
on the desktop, and two desktop windows on one pane stop fighting. The next
transport — a cloud host — is a file in `src/bridge/transports/`, not a
project.

**Harder.** This is a 140-method migration through the app's narrowest waist,
and a mistake in it is not a compile error in most cases — it is a method that
resolves to nothing at runtime, which is why D7's check is a ticket and not a
nice-to-have. `assert*` running on desktop calls will reject calls that used
to pass, and each one is a real latent bug arriving as a regression. The
proxy replaces 211 explicitly written preload methods with a dispatch rule, so
a typo in a method name is a rejected promise rather than `undefined is not a
function` — better, but different.

**Risks.** The preload is the security boundary, and this ADR rewrites it:
after D2/D3 anything in the page can call `manorHost.invoke(ns, method, …)`,
so the table is the whole allowlist and `LOCAL_ONLY` is the only thing between
a `full` device and pairing more devices. The sender check in D2 is the other
half; a `<webview>` guest reaching `bridge:invoke` would be the worst bug this
ADR could ship. Event migration is where silence hides: a `webContents.send`
that nobody converts is a feature that quietly stops updating, which typecheck
cannot see and only the E2E suite will.

**What implementation found.** None of the six rows below was this ADR's
subject. Four of them were only reachable because D1–D6 route the desktop and
a browser through the same table and the same connection registry — a bug
that only one caller could ever trigger had nowhere to hide once both callers
ran the identical code path.

| bug | since | fixed |
| --- | --- | --- |
| `MANOR_AGENT_KIND` silently dropped between the IPC handler and the daemon client — codex and pi panes reported as `claude` | ADR-135 | `d04d8ed` (ticket 5) |
| the web app's zustand stores called the bridge inside `create()`'s own initializer, before `window.electronAPI` existed, and the `?.`-guard swallowed the failure | ADR-178 slice 1 | `07c8d67` (ticket 14) |
| `layout.reportViewport` stripped `claim` from every caller — detach-to-window silently stopped working, caught before shipping only because `detach.spec.ts` exists | this ADR, ticket 6 | ticket 6 |
| one viewer's `pty.detach` unsubscribed the daemon's stream unconditionally on unmount, freezing every other viewer's terminal | ADR-178 slice 1 | `23023f0` |
| a device refused a `LOCAL_ONLY` method wrote nothing to the audit log — a stolen token probing for power left no trace | ADR-178 slice 1 | `6bd3a3d` |
| …and auditing that refusal made every browser's mount of `App.tsx` write a `rejected` line for `pty.updatePrewarmCwd`, which the device never meant to send | this ADR | `e89c96c` |

**A known-failure list is where tests go to die.** Five E2E specs were carried
through this ADR as pre-existing failures unrelated to it, and three of them
had quietly stopped testing their subject rather than caught anything real:
`sidebar-pr-tweaks.spec.ts` — a comment card's class names moved to
`ui/PrCommentCard` in an earlier commit, so four comment authors read as zero
and every assertion below the count passed vacuously; `claude-resize-duplication.spec.ts`
— the only spec that drives a real `claude` at the ADR-163/164/165
resize-duplication bug — had its trust prompt invert (`❯ No, exit` is now the
default), so a bare `Enter` quit the agent instead of accepting, and it had
been failing 120 seconds at a time, silently, long enough to be carried as a
known issue; `read-state.spec.ts:139` was stale since ADR-167, waiting on a
`data-testid` the sidebar stopped rendering the day the workspace row got its
own indicator dot. `command-palette-frequent.spec.ts` and `pr-badge-matrix.spec.ts`
were the other two of the five, both plain fixture drift (a UI change kept
matching frequent commands pinned while filtering; lucide renamed an icon and
left a compiling re-export behind). A sixth, unrelated to the known-failure
list but the same shape of trap: `app-menu.spec.ts`'s first test raced
Electron's own default menu on a slow boot, reading it before Manor's
`rebuild()` had replaced it, and failed only in full-suite runs. None of these
was a hard bug, and that is exactly the point: a spec that fails for a reason
that has nothing to do with what it tests accretes trust nobody re-earns until
someone reads the failure rather than re-adding it to the list.

**A misread, worth recording because it was repeated before it was checked.**
`web-app.spec.ts`'s audit-allowlist assertion failed with `Expected:
"agents.markSeen" / Received: ["pty.create", "agents.setPaneContext"]`. Ticket
12 read that as "the browser never calls `agents.markSeen`," and the
orchestrator repeated the reading before checking it. Backwards: the
assertion is `expect([...allowed]).toContain(entry.route)`, so the *received
array* is the allowlist and the *expected value* is the actual route — the
failure means an audit line for `agents.markSeen` **was written**, because
`markVisibleAgentsSeen` fires on every viewport change and the browser's own
call to it left a line the spec's two-route allowlist rejected. The app was
right; the spec was stale, and is fixed to allow the route rather than
require it.

**Not decided here.** Cloud authentication. Whether `electron/routes/` ever
collapses into the table. Whether the desktop ever attaches to a remote host
by default. Whether a renderer's `pty.detach` should ever reach the daemon at
all, given a renderer is the Manor server's viewer and not the daemon's
client (ADR-178 D4) — raised while chasing `read-state.spec.ts:139` on the
hypothesis that a detach with no remaining viewer left a background pane's
server-derived state stale. A release-only `pty.detach` was built and the
spec run three times against it, still failing 3/3; reverted, and
`23023f0`'s guarded detach (drop the daemon stream only when the last viewer
lets go) stands unchanged. The hypothesis was tested, not demonstrated — the
spec's real cause was unrelated (see above) — so the layering question it
raised is recorded and left for a future ADR rather than answered here.

**Follow-ups, recorded rather than done.**

- A follower's shrunken terminal font is never restored when it becomes the
  winsize owner (`useTerminalResize`).
- `web-app.spec.ts`'s existing D6 test comments that the browser becomes "the
  pane's only viewer," but `Meta+w` removes the pane for every renderer — the
  new window-close test this ADR added is the real proof of that property.
  The old comment overclaims and should be reworded or retired.
- `agent-hooks.test.ts`'s queue-cap test ("caps the queue at MAX_PENDING and
  drops newest overflow events") times out at 5s under full-suite load;
  passes 5/5 in isolation. Load-dependent, pre-existing, not chased.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
