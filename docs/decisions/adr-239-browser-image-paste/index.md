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

# ADR-239: Browser image paste

## Context

In the web app, whether in a desktop-sized browser or on a phone, pasting a clipboard image into a terminal pane does nothing. On the desktop, ADR-187 handles a pane on a remote host this way: the native `terminal.pasteClipboardImage` reads the **desk's** clipboard (`clipboard.readImage`), writes the PNG to `~/.manor/pasted-images/` on the pane's host, and pastes the path. A browser's image is on the browser's clipboard, which no Manor server can read. So `src/bridge/unavailable.ts:154` answers that method `{kind:"none"}`.

On the web, `isRemotePane()` is true for every pane, because the router stamps a server's `local` host as the server's id (`src/bridge/router.ts:478-484`). So the capture-phase paste listener in `useTerminalLifecycle` fires, gets "none" back, and falls back to nothing. The bytes in `e.clipboardData` are never read.

Only the bridge can carry the bytes, and the bridge is JSON text: one `JSON.stringify` per frame, with no binary path. A viewer's frame is capped at 1 MiB (`MAX_FRAME_BYTES`, `src/lib/relay-crypto/channel.ts:21`). Over the cap, `sealFrame` throws, and `relay-pipe.ts` closes the **whole connection** (`CLOSE_CHANNEL_FAILED`). The relay worker caps messages at 1 MiB too (`MAX_RELAY_PAYLOAD_BYTES`). Retina screenshots are usually 1–5 MB as PNG.

## Decision

**D1. One shared writer for pasted images.** `electron/server/pasted-images.ts` exports `writePastedImage(registry, hostId, bytes, ext)`. It writes `~/.manor/pasted-images/<yyyymmdd-hhmmss>-<8 hex>.<ext>` through `registry.get(hostId).shell`, never `RoutedBackend.shell`, as in ADR-187, and keeps the 7-day sweep. The native `uploadClipboardImage` (`electron/ipc/paste-image.ts`) calls it with `"png"`. Its signature and result stay the same. Constants shared by browser and main live in `src/lib/pasted-image.ts`, which imports nothing:
- `MAX_PASTED_IMAGE_BYTES` is 16 MiB, under the daemon's 20 MiB `writeFile` cap.
- `PASTED_IMAGE_CHUNK_BYTES` is 512 KiB of raw bytes, about 700 KiB of base64 per frame.
- `PASTED_IMAGE_TYPES` covers png, jpeg (`.jpg`), gif and webp.

**D2. A `pasteImage` namespace on the handler table** (`electron/bridge/handlers/paste-image.ts`), over `{ backendRegistry, getPaneHostId }`:
- `begin(paneId, {mime, size})` → `{uploadId}`: checks the type and size, and resolves the pane's host (`getPaneHostId(paneId) ?? LOCAL_HOST_ID`).
- `chunk(paneId, uploadId, index, base64)`: chunks arrive in order, owned by the caller, each within the chunk size and the declared size.
- `commit(paneId, uploadId)` → `{path}`: requires every byte, writes once through `writePastedImage`, and drops the staging.
- `abort(paneId, uploadId)`: never throws.

Staging is module state:
- an upload id of 128 random bits, bound to `ctx.caller.id`;
- at most 4 uploads per caller and 128 MiB staged in total;
- uploads idle for 60 s are swept by a lazy, `unref()`'d 15 s timer.

Every method is `route: byPane(0)`, so the pane's own server answers:
- the renderer's router sends a browser's call to the pane's source;
- the desktop's `HostRouting` forwards a pane on an adopted host to that host's server.

Audit: only `commit` is `mutating`, which audits it with the pane as target. Chunks would add 32 lines per paste, and bodies are never recorded anyway. The namespace is added to `SERVER_METHODS`, `ROUTES` and the host server's `HOST_TABLE`. A browser upload never answers `local`: on the web, even a pane on the server's own machine needs the bytes.

**D3. A web-only client path that reads the image from the paste event.** `src/lib/paste-image-upload.ts`'s `uploadPastedImage(paneId, blob)`:
1. checks the type and size;
2. slices the blob into 512 KiB pieces and encodes each with `FileReader`;
3. calls begin, then each chunk, then commit, one after another;
4. aborts on any failure.

`pasteImageFile(term, paneId, blob)` in `src/lib/remote-image-paste.ts` pastes `path + " "`. Above one chunk it shows an "Uploading image to <host>…" toast; on failure, an error toast. It is wired behind an explicit `isWebApp()` check, never `isRemotePane`, which is always true on the web:
1. The DOM `paste` capture listener in `useTerminalLifecycle`: an image item with no text uploads.
2. Ctrl+V in `useTerminalHotkeys`: on the web, xterm skips the key and does not write `\x16`. The browser's own paste then fires the DOM event above.
3. The context-menu Paste in `TerminalPane` tries `navigator.clipboard.read()` for an image, then falls back to text.

**D4. The phone's chat composer pastes images too.** An image-only paste into `ChatComposer` uploads it and inserts `path + " "` at the caret. `chat.send` types its text without bracketed paste, so the ticket first checks that Claude Code attaches a typed path. If it does not, the ticket stops and records that here.

**D5. The desktop is unchanged.** The native `terminal.pasteClipboardImage` stays the desktop's path. It stays answered in `SERVED_HERE` on the web, with a comment pointing at `pasteImage.*`.

### Rejected

- **One call, image shrunk to fit a frame.** Downscaling or re-encoding makes screenshot text illegible, which is the main use. It also turns a transport limit into a product limit.
- **Hybrid: one call when small, chunks when large.** Two paths and two sets of tests to save two round trips.
- **Append each chunk straight onto the host file.** The daemon protocol would grow (ADR-187 avoided a bump), the 128 KiB argument limit returns for the exec fallback, and a reader could see a partial file.
- **Upload over HTTP, outside the bridge.** The relay is a blind pipe, and nothing on the desk listens for HTTP from a paired device.

## Consequences

- A browser or phone can paste images up to 16 MiB, losslessly, into any pane: on the desk's machine, on an ssh host, or on a host server.
- **Memory.** Staging holds at most 16 MiB per upload, 4 uploads per caller and 128 MiB in total, for 60 s idle. The server enforces this whatever the client does.
- **Security.** A paired device can already run `pty.write` and `pty.create`. A file whose name the server picks, under `~/.manor/pasted-images`, adds no new power (ADR-187's point). `commit` is audited.
- **Relay cost.** Base64 sends about 1.37× the image's size, against the 2 GiB/day per-room budget. A 16 MiB image is 32 sequential round trips, a few seconds over a relay; the toast covers it.
- **A source change mid-upload** (a host server coming or going) fails the paste with a toast. The user pastes again.
- **Ctrl+V on the web becomes a browser paste instead of `\x16`.** That is better for text, because Claude Code's `\x16` reads the server's clipboard, but a literal `\x16` is lost on the web. The desktop is unaffected.
- `navigator.clipboard.read()` asks for permission in Chromium and is limited in Firefox. There the context-menu Paste falls back to text; keyboard paste is the main path.
- The e2e test pastes 1.5 MiB through the real relay. It is the one proof that the chunks are sized under the frame cap.

### Found in review and evidence

- **A repeated `commit` wrote the image twice.** The staged upload stayed in place during the write. It is now removed before the write starts, so a repeat answers "Unknown upload".
- **Text typed in the phone composer during an upload was overwritten** by the path insert. The insert now works from the latest text and caret.
- **Paste toasts named a relayed server by its room id** (ticket 7). The fix is the same as d078efb6's for the sidebar: prefer `serverHostName`.
- **Open:** it is unverified whether Claude Code attaches an image from a path that `chat.send` *types*. If it doesn't, `chat.send` needs a bracketed paste for this case.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
