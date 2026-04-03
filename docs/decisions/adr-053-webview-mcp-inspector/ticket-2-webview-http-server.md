---
title: Webview HTTP server — local API for webview operations
status: done
priority: critical
assignee: opus
blocked_by: [1]
---

# Webview HTTP server — local API for webview operations

Create a local HTTP server in the main process that exposes webview inspection and interaction endpoints. Follows the same pattern as `AgentHookServer`.

## Implementation

### New file: `electron/webview-server.ts`

Create a `WebviewServer` class with the same lifecycle pattern as `AgentHookServer`:

```ts
export class WebviewServer {
  private server: http.Server | null = null;
  private port = 0;
  private registry: Map<string, number>; // paneId → webContentsId
  private consoleLogs: Map<string, ConsoleEntry[]>; // paneId → ring buffer

  constructor(registry: Map<string, number>) { ... }

  get serverPort(): number { return this.port; }

  async start(): Promise<void> { ... }
  stop(): void { ... }
}
```

**Port file**: Write port to `~/.manor/webview-server-port` on start, delete on stop.

**Console log buffering**: When a webview is registered, attach a `console-message` event listener to its webContents. Buffer last 200 entries per pane as `{ timestamp: string, level: 'log'|'warn'|'error'|'info', message: string }`. Clean up listener when unregistered.

### Endpoints

All endpoints are `127.0.0.1` only. Parse URL with `new URL()`. Use JSON request/response bodies.

**`GET /webviews`**
Return array of `{ paneId, url, title }` for all registered webviews. Get URL and title from `webContents.getURL()` and `webContents.getTitle()`.

**`POST /webview/:id/screenshot`**
Call `webContents.capturePage()` which returns a `NativeImage`. Convert to PNG base64 with `image.toPNG().toString('base64')`. Return `{ image: "base64..." }`.

**`POST /webview/:id/execute-js`**
Read `{ code: string }` from request body. Call `webContents.executeJavaScript(code)`. Return `{ result: <serialized result> }`. Wrap in try/catch for eval errors.

**`POST /webview/:id/dom`**
Execute JS in the webview to get a simplified DOM snapshot. Use a script that walks the DOM and returns a condensed HTML representation (tag names, key attributes like id/class/role/aria-label, text content). Keep it concise — strip style/script tags, limit depth. Return `{ html: "..." }`.

**`POST /webview/:id/click`**
Accept `{ selector?: string, x?: number, y?: number }`. If selector provided, execute JS to find the element, get its bounding rect center, then use `webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left' })` followed by `mouseUp`. If x,y provided directly, use those coordinates.

**`POST /webview/:id/type`**
Accept `{ selector?: string, text: string }`. If selector provided, first click the element (same as click), then for each character in text, send `webContents.sendInputEvent({ type: 'char', keyCode: char })`.

**`POST /webview/:id/navigate`**
Accept `{ url: string }`. Call `webContents.loadURL(url)`. Return `{ ok: true }`.

**`GET /webview/:id/console-logs`**
Return the buffered console entries for this pane.

**`GET /webview/:id/url`**
Return `{ url: webContents.getURL() }`.

### Error handling

- If paneId not found in registry: return 404 `{ error: "Webview not found" }`
- If `webContents.fromId()` returns null (destroyed): return 410 `{ error: "Webview destroyed" }`, remove from registry
- Wrap all webContents operations in try/catch

### Helper: resolve webContents

Create a private method `getWebContents(paneId: string)` that looks up the registry, calls `webContents.fromId()`, validates it's not destroyed, and returns it or throws.

## Integration in `electron/main.ts`

1. Import `WebviewServer`
2. Create instance: `const webviewServer = new WebviewServer(webviewRegistry);`
3. Start in `app.whenReady()` after window creation: `await webviewServer.start();`
4. Stop in `before-quit`: `webviewServer.stop();`
5. When `webview:register` is called, also call `webviewServer.attachConsoleListener(paneId)` to start buffering
6. When `webview:unregister` is called, also call `webviewServer.detachConsoleListener(paneId)`

## Files to touch
- `electron/webview-server.ts` — new file, the HTTP server
- `electron/main.ts` — instantiate, start, stop, wire to registry
