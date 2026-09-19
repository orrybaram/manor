---
title: What the browser cannot do says so
status: todo
priority: medium
assignee: sonnet
blocked_by: [4]
---

# What the browser cannot do says so

ADR-178 "What can never mirror in a browser", and the read-and-type
intermediate state from D10. Every native-only feature degrades to a stated
empty state; nothing crashes, nothing silently no-ops.

## A single predicate

- `src/lib/platform.ts` (new) — `isWebApp(): boolean` reading
  `window.electronAPI.platform === "web"`. Use this, not `navigator` sniffing,
  and not `try/catch` around bridge calls.

## Surfaces

- `src/components/workspace-panes/BrowserPane/BrowserPane.tsx` — when
  `isWebApp()`, render the existing `EmptyState` pattern (see
  `src/components/EmptyState.module.css` and ADR-058's browser empty state)
  with the copy "Browser panes need the desktop app" and a `<Link>` from
  `ui/Link/Link` to the pane's URL, which opens a new tab in a browser.
  Do not mount `<webview>`.
- Command palette (`src/components/command-palette/`) and the app menu
  handlers (`src/lib/menu-handlers.ts`, `src/lib/keybinding-commands.ts`) —
  commands whose only implementation is a native namespace (`window.*`,
  `menu.*`, `dialog.*`, `shell.openExternal` beyond what `<Link>` covers,
  `updater.*`, detach tab/pane, open in editor, element picker, screenshot,
  recording) are filtered out of the palette when `isWebApp()` and their
  keybindings are no-ops. Find them by grepping the namespaces in
  `src/web/unavailable.ts` (ticket 4) across `src/`.
- Sidebar / tab bar affordances that call those namespaces (detach buttons,
  "Open in editor", "Reveal in Finder") — hidden, not disabled, following the
  remote client's "remove, don't disable" rule.
- Layout writes — the store already calls `window.electronAPI.layout.save` on a
  debounce (`app-store.ts` ~3340). On the web this rejects with
  `BridgeUnavailableError`. Catch it **once**: show a single toast via
  `toast-store.ts` — "Layout changes aren't saved from the browser yet" — and
  suppress further ones for the session. Keep the local mutation so the user
  is not blocked from looking; it just does not persist. Do not hide split /
  new-tab actions; hiding them would be lying about slice 2.
- `src/components/settings/` pages that write machine config (agent command,
  worktree scripts, keybindings, remote control itself) — render read-only
  with a one-line note when `isWebApp()`.

## Carried over from ticket 4's report

- `git.push` is a method *and* a namespace in `preload.ts`; on the web the
  bridge rejects `git.push.start` with `BridgeUnavailableError` (git is not on
  the slice-1 table). `DiffPane` / the git panel need an empty state for that
  rather than a raw rejection — same "says so" treatment as the rest.
- `src/web-main.tsx` grew `FullPageMessage`/`ForbiddenScreen` beside the
  entry and now trips `react-refresh/only-export-components` three times.
  Move the screens to `src/web/screens.tsx`; keep the `data-testid`s
  (`web-app-no-token`, `web-app-forbidden`) — ticket 7 relies on them.
- `clipboard.writeText` is served locally via `navigator.clipboard`
  (`LOCALLY_SERVED` in `src/web/unavailable.ts`). Leave it; it is harmless.

## Tests

- Component tests for `BrowserPane` (web → empty state with link, electron →
  webview) and for the palette filter, following whatever pattern
  `src/components/**/__tests__` already uses.

## Files to touch
- `src/lib/platform.ts` — new
- `src/components/workspace-panes/BrowserPane/BrowserPane.tsx` — empty state
- `src/components/command-palette/*` — filter native-only commands
- `src/lib/menu-handlers.ts`, `src/lib/keybinding-commands.ts` — no-op native-only commands on web
- `src/components/sidebar/*`, `src/components/tabbar/*` — hide native-only affordances
- `src/store/app-store.ts` — catch `layout.save` unavailable once
- `src/components/settings/*` — read-only machine-config pages on web
