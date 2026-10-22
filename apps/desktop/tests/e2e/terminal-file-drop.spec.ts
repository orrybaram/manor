import fs from "fs";
import path from "path";
import type { Page } from "@playwright/test";
import { bootWorkspaceWithTerminal, expect, test } from "./fixtures";
import { activePaneId, awaitShellReady, paneText } from "./helpers/terminal";

/**
 * Dropping a file onto a terminal pastes its path (#373). Playwright can't
 * start an OS drag, so each test dispatches `dragover` + `drop` on the pane
 * itself. For a file with a real path, the File comes from an
 * `<input type=file>` that `setInputFiles` filled: in Electron, that is a
 * File `webUtils.getPathForFile` can resolve, the same as one from Finder.
 */

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

/** Drop whatever files `#drop-source` holds onto the visible terminal. */
async function dropFromInput(window: Page): Promise<void> {
  await window.evaluate(() => {
    const input = document.getElementById("drop-source") as HTMLInputElement;
    const dt = new DataTransfer();
    for (const f of Array.from(input.files ?? [])) dt.items.add(f);
    const target = document.querySelector(
      '[data-testid="terminal-pane"] .xterm-screen',
    )!;
    for (const type of ["dragenter", "dragover", "drop"]) {
      target.dispatchEvent(
        new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }),
      );
    }
  });
}

test("dropping a screenshot pastes its quoted path", async ({ app, window, tempHome }) => {
  await bootWorkspaceWithTerminal(app, window, tempHome, "ws-drop");
  const paneId = await activePaneId(window);
  await awaitShellReady(window, tempHome, paneId);

  const shot = path.join(tempHome, "Screenshot 2026-10-22 at 9.41.03 AM.png");
  fs.writeFileSync(shot, TINY_PNG);
  await window.evaluate(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.id = "drop-source";
    input.style.display = "none";
    document.body.appendChild(input);
  });
  await window.setInputFiles("#drop-source", shot);
  await dropFromInput(window);

  await expect
    .poll(() => paneText(window, paneId), { timeout: 10_000 })
    .toContain(`'${shot}'`);
  // Nothing was uploaded: the file is already on this machine.
  expect(fs.existsSync(path.join(tempHome, ".manor", "pasted-images"))).toBe(false);
  await window.screenshot({ path: test.info().outputPath("dropped-screenshot.png") });
});

test("dropping an image with no path on disk uploads it", async ({ app, window, tempHome }) => {
  await bootWorkspaceWithTerminal(app, window, tempHome, "ws-drop-blob");
  const paneId = await activePaneId(window);
  await awaitShellReady(window, tempHome, paneId);

  // An image dragged out of a web page: bytes, no file behind them.
  await window.evaluate((b64) => {
    const raw = atob(b64);
    const data = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) data[i] = raw.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([data], "image.png", { type: "image/png" }));
    const target = document.querySelector(
      '[data-testid="terminal-pane"] .xterm-screen',
    )!;
    for (const type of ["dragenter", "dragover", "drop"]) {
      target.dispatchEvent(
        new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }),
      );
    }
  }, TINY_PNG.toString("base64"));

  await expect
    .poll(() => paneText(window, paneId), { timeout: 20_000 })
    .toContain("/.manor/pasted-images/");
  await window.screenshot({ path: test.info().outputPath("dropped-blob.png") });
});
