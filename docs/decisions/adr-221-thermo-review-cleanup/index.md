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

# ADR-221: Thermo-review cleanup of the v0.20.1..HEAD changes

## Context

A strict maintainability review ("thermo-nuclear") of everything unreleased since `v0.20.1` (ADR-218 TUI menus, ADR-219 agents-first drawer, ADR-220 phone resync, the tracker image proxy and assorted fixes) blocked all four areas. Behaviour is correct and well tested; the problems are structural, and two are latent bugs:

- **Menu handoff writes the persisted view.** `startMenuHandoff` (`usePaneChatView.ts`) writes `"terminal"` to localStorage while the handoff lives only in memory; a reload mid-handoff strands the pane on the terminal with no key bar. Ending a handoff is spread across ChatPane, a LeafPane ref + `useEffect`, PhoneOverflowMenu and a `returnToChat?` option.
- **`chatSend` is not atomic.** `electron/bridge/handlers/chat.ts` writes text, sleeps 120 ms, writes Enter; a concurrent send, `chat.key` or `chat.interrupt` interleaves in the PTY.
- **Layout resync fakes broadcasts** on a wrong premise (`loadPersistedLayout` does not reconcile stale agents or pick the active workspace — `App.tsx` does). It drops `paneSessions` and never removes server-deleted workspaces (ADR-220 ticket 6 planned to bolt those on).
- **WS transport liveness is half-optional** (`probe?`/`close?` plus a `redialImmediately` flag that crosses an `await`), with three overlapping public entry points, one of which reports `"redialing"` when stopped.
- **ChatComposer runs two parallel listbox state machines** (`/` menu and choice sheet) with duplicated key handling, aria and index math.
- **Feature logic leaks into shared code:** drawer-close wiring inside the desk `Sidebar` (against ADR-219), provider switches around the image proxy (against ADR-202's tracker port), phone-greeting name logic inside `GitHubManager`.
- **Duplicates of canonical helpers:** greeting, URL parsing (three copies), agent context resolution, status classification, resync boot wiring in ~7 stores, nav callbacks.
- A raw `useEffect` in StatusBar against the repo's react rule, dead exports, and a two-boolean/three-state command metadata contract.

## Decision

Keep every behaviour; restructure so the special cases disappear. One ticket per cohesive area:

1. **Just-updated:** replace `hasJustUpdated` + `acknowledgeJustUpdated` with one `takeJustUpdated()`; StatusBar has no effect.
2. **Menu handoff as an overlay:** effective view = `handoff ? "terminal" : storedView`; the stored view is never written by a handoff. The handoff records the transcript it started on; "a new transcript ends it" is derived. One `endMenuHandoff(paneId)` with no options. Pure handoff code moves to `menu-handoff.ts` so `chat-entries.ts` no longer imports from a store.
3. **Per-pane serialized PTY writes** in the chat handler: `chat.send`, `chat.key`, `chat.interrupt` all go through one per-pane queue; the type-then-submit sequence is one unit. `CHAT_KEYS` moves to `chat-keys.ts`, trimmed to what is used.
4. **Command metadata `menu?: "always" | "bare-only"`** replaces `interactive` + `argSkipsMenu`; dead `isInteractiveCommand` / `firstWordCommand` deleted; a pure `commandEffect()` replaces post-send ad-hoc branches.
5. **One listbox in the composer:** the choice sheet becomes the second level of the `/` menu behind a shared `{ listboxId, rows, selectedIndex, move, activateSelected, dismiss }` interface.
6. **WS liveness contract:** `probe`/`close` required on `PipeConnection`; failed probe tears down and redials directly; only `probeNow(): "alive" | "redialing" | "stopped"` is public. `HelloReply.resumed` replaces `helloCount`.
7. **`applyLayoutSnapshot`:** extract the merge from `loadPersistedLayout` into its own module; boot and resync both use it; it drops server-removed workspaces via the `removed` path and seeds `paneSessions`. **Supersedes ADR-220 ticket 6.**
8. **Lifecycle-scoped resync:** `bootAndResync(load)` in `src/bridge/resync.ts`; agent-activity and ports register resync inside their start functions; theme goes through one `applyServerTheme`.
9. **Drawer wiring:** one `closeThen` wrapper for every drawer action; revert the Sidebar `onShowAll` composition; gesture hooks to `phone/useDrawerSwipe.ts` with one direction-lock helper; edge swipe gated by an explicit `enabled`.
10. **Agents drawer model owns derivations:** reuse `resolveAgentContext`, take `paneAgentStatus` directly, one `rowState(status)`, `group.key`, two-pass sort, shared nav hook, shared time helpers, honest "Needs you" naming.
11. **One greeting helper** shared by dashboard and phone.
12. **`TaskTracker.imageQuery(url)`** replaces provider switches; one shared `parseHttpUrl` in `src/lib/http-url.ts`.
13. **Electron image/name boundary:** `fetchImageDataUrl` enforces trust itself; GitHub image token + proxy move to `electron/github-images.ts`; main exposes the raw viewer name, the renderer owns first-name splitting and caching.
14. **GfmMarkdown contract:** `renderImage` required; one link-propagation policy; deliberate sanitize `clobberPrefix`. Plus the ChatEntryView notice class.

## Consequences

- Fixes two real bugs (stranded terminal view after reload; interleaved PTY writes) and two resync data gaps.
- `github.ts` and `app-store.ts` shrink instead of grow; `Sidebar` goes back to being drawer-agnostic.
- Wide surface: 14 tickets across bridge, stores, phone UI, electron. Tickets 6–8 overlap files with ADR-220's remaining tickets (4, 5, 7) — they must not run concurrently with that work.
- The drawer's "Needs you" section is renamed or derived from `needsYouItems`; a small visible copy change.
- Shortening `CHAT_KEYS` narrows the bridge's key surface (unused keys only).

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
