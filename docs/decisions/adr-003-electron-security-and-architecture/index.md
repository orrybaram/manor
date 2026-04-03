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

# ADR-003: Electron Security Hardening & Architecture Improvements

## Context

An architecture review of Manor's Electron setup identified several gaps across security, IPC design, process model resilience, and distribution. While the core architecture is sound (context isolation, persistent daemon, token-based auth), there are missing defense-in-depth layers that Electron best practices recommend.

Key findings:
- **No Content Security Policy** — the renderer has no CSP, leaving it open to XSS escalation
- **Sandbox disabled** — `sandbox: true` is not set in webPreferences, giving the renderer unnecessary system call access
- **No URL validation on `openExternal`** — any string from the renderer is passed directly to `shell.openExternal`
- **No IPC input validation** — main process handlers accept renderer arguments without type/shape checking
- **No daemon version handshake** — after an app update, the running daemon may be from the old version with no way to detect or handle the mismatch
- **Preload is a flat 195-line file** — ~40+ handlers in one namespace, increasingly hard to maintain
- **Agent detection still polls at 500ms** — despite having the AgentHookServer for lifecycle events, polling remains the primary detection path
- **No auto-update mechanism** — users must manually update

## Decision

Address these in priority order across 6 tickets:

1. **Add CSP meta tag** to `index.html` restricting script/style/connect sources
2. **Enable sandbox** in webPreferences — already compatible since we use contextBridge properly
3. **Validate `openExternal` URLs** — whitelist `https:` and `http:` protocols in the main process handler
4. **Add IPC input validation** — add a lightweight validation layer for main process IPC handlers, focusing on type checks for security-critical handlers (pty:write, pty:create, shell:openExternal, linear:connect, projects:add)
5. **Add daemon version handshake** — include app version in the auth message; if mismatched, gracefully restart the daemon
6. **Namespace the preload bridge** — restructure `electronAPI` into grouped sub-objects (pty, layout, projects, theme, ports, branches, diffs, github, linear, dialog, shell) and update all renderer references

Out of scope for this ADR (future work):
- Auto-updater setup (requires signing certificates, release infrastructure)
- Agent detection refactoring (hook server is still experimental)
- Terminal output batching improvements (already at 4ms/64KB, adequate)

## Consequences

**Positive:**
- Defense-in-depth security model matching Electron best practices
- Daemon version mismatches detected automatically instead of causing subtle bugs
- Preload bridge becomes maintainable and auditable as the API surface grows
- IPC validation catches malformed data at the boundary rather than deep in business logic

**Negative:**
- CSP may need tuning if future features require loading external resources
- Daemon restart on version mismatch briefly interrupts active terminal sessions (acceptable since it only happens on app updates)
- Preload namespace change touches every renderer file that uses `window.electronAPI` — moderate blast radius

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
