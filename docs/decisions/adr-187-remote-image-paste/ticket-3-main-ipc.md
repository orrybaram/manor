---
title: Main-process IPC to upload the clipboard image to a pane's host
status: done
priority: high
assignee: sonnet
blocked_by: [2]
---

# Main-process IPC to upload the clipboard image to a pane's host

See ADR-187 §3.

In `electron/ipc/misc.ts`, next to `clipboard:writeText`, register `ipcMain.handle("terminal:pasteClipboardImage", async (_e, paneId: string) => …)`. Validate with `assertString`. It gets `backendRegistry` from `IpcDeps`; check how `misc.ts`'s `register` receives deps and extend its signature if needed.

Logic:
1. `const hostId = backendRegistry.sessions.ownerOf(paneId)`. If it is undefined or `LOCAL_HOST_ID`, return `{ kind: "local" }`.
2. `const img = clipboard.readImage()`. If `img.isEmpty()`, return `{ kind: "none" }`.
3. `const host = backendRegistry.get(hostId)`. Then `const home = await host.shell.homeDir()` and `const dir = \`${home}/.manor/pasted-images\``. The filename is `<yyyymmdd-hhmmss>-<crypto.randomBytes(4).toString("hex")>.png`, joined with `path.posix.join`.
4. `await host.shell.writeFile(filePath, img.toPNG())` and then return `{ kind: "uploaded", path: filePath }`.
5. Fire and forget: `host.shell.exec("find", [dir, "-type", "f", "-mtime", "+7", "-delete"]).catch(() => {})`.
6. On any error, return `{ kind: "error", message: errorMessage(err) }`.

Export the result type as `PasteClipboardImageResult` from `src/electron.d.ts`. Expose it in `electron/preload.ts` as `terminal: { pasteClipboardImage: (paneId) => ipcRenderer.invoke("terminal:pasteClipboardImage", paneId) }`, merging into an existing `terminal` namespace if there is one, and add the matching type to the `ElectronAPI` interface in `src/electron.d.ts`.

Add a unit test if `misc.ts` handlers have tests; otherwise extract the logic into a small pure-ish function (`uploadClipboardImage(registry, paneId, clipboardImage)`) in `electron/ipc/paste-image.ts` and test that.

## Files to touch
- `electron/ipc/misc.ts` (or new `electron/ipc/paste-image.ts` + test)
- `electron/ipc/types.ts` if deps wiring changes
- `electron/preload.ts`
- `src/electron.d.ts`
