---
title: Main→renderer app-command bridge + start_agent HTTP route
status: todo
priority: high
assignee: sonnet
blocked_by: []
---

# Main→renderer app-command bridge + `start_agent` HTTP route

Add the plumbing that lets the main process ask the renderer to open a new
agent pane in a given workspace. This is the load-bearing new piece — pane
creation is renderer-driven, so `start_agent` must round-trip through the UI.

## Part A — `WebviewServer.startAgent()` + `POST /agents` route

In `electron/webview-server.ts`:

- Add a method `startAgent(workspacePath: string, prompt?: string): { ok: boolean; error?: string }`:
  - Get the first window: `const win = BrowserWindow.getAllWindows()[0];`
    (import `BrowserWindow` from `electron` — the file already imports from
    `electron`). If none, return `{ ok: false, error: "No Manor window is open" }`.
  - `win.webContents.send("app-command", { cmd: "start-agent", workspacePath, prompt });`
  - Return `{ ok: true }`.
- Add a route in `handleProjectRequest`'s sibling area (or a small new branch in
  `handleRequest`, before the `/webviews` route, alongside the `/projects` check):

  ```
  if (method === "POST" && url.pathname === "/agents") {
    const body = await readBody();
    const workspacePath = body.workspacePath;
    if (typeof workspacePath !== "string") {
      json(400, { error: "Missing 'workspacePath' string in request body" });
      return;
    }
    const prompt = typeof body.prompt === "string" ? body.prompt : undefined;
    const result = this.startAgent(workspacePath, prompt);
    json(result.ok ? 200 : 503, result);
    return;
  }
  ```

  `readBody` and `json` are the closures already defined inside `handleRequest`.

## Part B — preload + renderer wiring

In `electron/preload.ts`:
- Add `onAppCommand(callback)` to the exposed `electronAPI`, forwarding the
  `"app-command"` channel. Mirror an existing `on…` forwarder (e.g. the
  `task-updated` listener around `preload.ts:378`) — return a cleanup function
  that removes the listener.

In `src/electron.d.ts` (and `src/webview.d.ts` if types are split there):
- Add the `onAppCommand` signature to the `electronAPI` type. The payload type is
  `{ cmd: string; workspacePath?: string; prompt?: string }`.

In `src/App.tsx`:
- In an effect (near the other `electronAPI.on…` subscriptions), register
  `onAppCommand` and handle `cmd === "start-agent"`:
  ```
  await loadProjects();               // ensure a freshly-created workspace is visible
  setActiveWorkspace(workspacePath);  // App.tsx already imports setActiveWorkspace
  if (prompt) handleNewTaskWithPrompt(prompt);
  else handleNewTask();
  ```
  `loadProjects`, `setActiveWorkspace`, `handleNewTask`, and
  `handleNewTaskWithPrompt` all already exist in `App.tsx`. Use the existing
  `…Ref.current` pattern if these are defined below the effect (see how
  `handleNewTaskRef` is used at `App.tsx:484`).
- Clean up the listener on unmount.

## Verification
- `pnpm build` succeeds.
- Manually reason through: a `POST /agents { workspacePath, prompt }` to the
  webview server results in a new tab opening in that workspace with the agent
  command + prompt injected.

## Files to touch
- `electron/webview-server.ts` — `startAgent()` method, `POST /agents` route, import `BrowserWindow`
- `electron/preload.ts` — expose `onAppCommand`
- `src/electron.d.ts` — type `onAppCommand`
- `src/App.tsx` — subscribe to `app-command`, handle `start-agent`
