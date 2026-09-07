---
title: System, integration, and webview-extra routes and tools
status: todo
priority: medium
assignee: opus
blocked_by: [1, 5]
---

# System, integration, and webview-extra routes and tools

The long tail. Each route mirrors one IPC handler; read the handler first and call the same manager method with the same validation. Where ticket 1 extracted a function (`process-control.ts`, `editor.ts`), call that.

## Routes — new `electron/routes/system.ts`

| Prefix | Routes |
|---|---|
| `/notifications` | `GET /notifications`, `POST /notifications/:id/read`, `POST /notifications/read-all`, `DELETE /notifications` — each mutation then `sendNotificationsUpdate(mainWindow)` (get the window via `getRendererWindows()[0]`) |
| `/processes` | `GET /processes` (`listProcesses`), `POST /processes/cleanup-dead`, `POST /processes/kill-daemon`, `POST /processes/kill-all`, `POST /processes/restart-portless` |
| `/ports` | `GET /ports` (`portScanner.scanNow()` result), `POST /ports/kill` `{ pid }` (`backend.ports.kill`) |
| `/preferences` | `GET /preferences`, `POST /preferences` `{ key, value }` — validate `key` against the `AppPreferences` keys; reject unknown |
| `/theme` | `GET /theme` (selected name + theme), `GET /theme/all` (`loadAllThemeColors`), `POST /theme` `{ name }` |
| `/stats` | `GET /stats`, `DELETE /stats` |
| `/remote-control` | `GET /remote-control` (`status()`), `POST /remote-control/enabled` `{ enabled }`, `POST /remote-control/tunnel/start`, `POST /remote-control/tunnel/stop`, `POST /remote-control/refresh` |
| `/shell` | `POST /shell/open-in-editor` `{ path }` (`openInEditor`), `POST /shell/open-external` `{ url }` (same URL validation as `shell:openExternal`) |
| `/windows` | `GET /windows` (same shape as `window:listWindows`) |
| `/updater` | `POST /updater/check`, `POST /updater/quit-and-install` |

New `electron/routes/integrations.ts`: `POST /linear/issues/:id/start`, `POST /linear/issues/:id/close`, `GET /github/status`, `POST /projects/:projectId/issues` `{ title, body }` → `githubManager.createIssue` (read its signature). Register both modules in `routes/index.ts`.

Webview extras go in `electron/webview-server.ts` inside the `/webview/:id/*` block, next to `navigate`: `POST zoom-in`, `zoom-out`, `zoom-reset`, `find` `{ text }`, `stop-find`, `mute` `{ muted }`, `stop`. Each does what the matching `webview:*` IPC handler in `electron/ipc/webview.ts` does; share the webContents lookup.

## Tools

New `electron/mcp/tools-system.ts` (label `system`, registered last in `modules.ts`): `list_notifications`, `mark_notification_read`, `mark_all_notifications_read`, `clear_notifications`, `list_processes`, `cleanup_dead_processes`, `kill_daemon`, `kill_all_processes`, `restart_portless`, `scan_ports`, `kill_port`, `get_preferences`, `set_preference`, `get_theme`, `list_themes`, `set_theme`, `get_stats`, `reset_stats`, `remote_control_status`, `set_remote_control_enabled`, `start_tunnel`, `stop_tunnel`, `open_in_editor`, `open_external`, `list_windows`, `check_for_updates`, `quit_and_install`, `start_linear_issue`, `close_linear_issue`, `github_status`, `create_github_issue`.
`electron/mcp/tools-webview.ts`: `zoom_in`, `zoom_out`, `zoom_reset`, `find_in_page`, `stop_find`, `set_audio_muted`, `stop_loading`.

Destructive tools (`kill_all_processes`, `kill_daemon`, `quit_and_install`, `clear_notifications`, `reset_stats`) say so in the first sentence of the description.

## Tests
- `electron/routes/system.test.ts`: notifications mark-read broadcasts; `set_preference` with an unknown key → 400; `GET /processes` returns `listProcesses` output.
- `router.test.ts` passes with the new prefixes.

## Files to touch
- `electron/routes/system.ts` — new
- `electron/routes/integrations.ts` — new
- `electron/routes/system.test.ts` — new
- `electron/routes/index.ts` — register
- `electron/webview-server.ts` — webview extras
- `electron/mcp/tools-system.ts` — new
- `electron/mcp/tools-webview.ts` — extras
- `electron/mcp/modules.ts` — add `system`
