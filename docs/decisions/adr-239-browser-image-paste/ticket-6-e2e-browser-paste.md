---
title: "E2E: a paired browser pastes an image into a pane on the desk"
status: done
priority: high
assignee: sonnet
blocked_by: [4]
---

# E2E: a paired browser pastes an image

Add a test to `tests/e2e/web-app.spec.ts`, inside the existing describe: "a browser pastes an image into a pane: the bytes land in ~/.manor/pasted-images on the desk and the path is pasted".

**Setup.** Boot the way the file's first test does: `importSeededProject`, `createWorkspace`, `openTerminalTab`, `activePaneId`, `awaitShellReady`. No fake agent is needed. Then `pairBrowser`, `closeSettings`, `openWebApp`, wait for the sidebar, and click the terminal pane.

**Helper.** Add `pasteImageIntoPane(page, paneId, bytes, type)` in `tests/e2e/helpers/terminal.ts`. Its `page.evaluate`:
1. builds `new File([bytes], "shot.png", { type })`;
2. creates a `DataTransfer` and adds the file to it;
3. dispatches `new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })` on the pane's xterm textarea (`window.__manorTerminals`; check how other helpers reach it).

Pass the bytes across `evaluate` as base64 or a number array.

**Case 1.** Paste a real 1x1 PNG. Then:
- poll `~/.manor/pasted-images` under `tempHome` (the daemon's `HOME`; see `tests/e2e/fixtures.ts`) for a `.png` file whose bytes equal the input;
- `expect.poll` that the pane's text contains `/.manor/pasted-images/`.

**Case 2, the frame-cap proof.** Paste 1.5 MiB of pseudo-random bytes behind a PNG signature, with type `image/png`. Then:
- a second file appears with identical bytes;
- the connection stayed up: typing `echo still-here` shows in the pane afterwards.

A frame over 1 MiB would close the connection, so this case proves the chunks are sized under the cap.

**Audit.** The audit entries under `tempHome` contain `pasteImage.commit`, with the pane as `target` and outcome `sent`, and no `pasteImage.chunk` lines. Check the existing helper that reads the audit log.

Take filmstrip screenshots as the other tests do. Find out how `web-app.spec.ts` is run (`tests/e2e/README.md`, `package.json` scripts), run the new test, and report the result.

## Files to touch
- `tests/e2e/web-app.spec.ts`
- `tests/e2e/helpers/terminal.ts`
