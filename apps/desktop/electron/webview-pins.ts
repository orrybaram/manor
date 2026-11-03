/**
 * A browser pane's pins, main's half: the page script (`page-pins-script.ts`)
 * reports picks, pin clicks and pin positions on its console; this turns each
 * pick into a screenshot on disk and passes everything on to the pane's
 * renderer, which holds the notes and draws the popover and pill.
 *
 * The screenshot is the guest's `capturePage` of the element, cropped to the
 * viewport, taken while the page has its pins hidden. It is saved on this
 * machine first (Copy cites that path); sending to a remote workspace's agent
 * uploads it to that host through the pasted-images path.
 */
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { ipcMain, type WebContents } from "electron";
import type { BackendRegistry } from "./backend/registry";
import { LOCAL_HOST_ID } from "./backend/types";
import { assertString } from "./ipc-validate";
import { writePastedImage } from "./server/pasted-images";
import {
  PINS_PREFIX,
  PINS_SCRIPT,
  PIN_OPEN_PREFIX,
  PIN_PICK_PREFIX,
  PIN_REPORT_PREFIX,
  PIN_STOP_MESSAGE,
  pinsCall,
} from "./page-pins-script";
import type { PickedElementResult } from "../src/electron";
import { parsePickReport, parsePinOpen, parsePinsLayout, type PickReport } from "./page-pin-reports";

type Box = { x: number; y: number; width: number; height: number };

/** One click on the page while picking, with its screenshot once taken. */
export interface PagePick extends PickedElementResult {
  /** The page's id for it, which becomes its pin's. */
  pickId: string;
  /** Where it is on this machine, and main's handle to upload it; null if it couldn't be taken. */
  screenshot: { id: string; path: string } | null;
}

export type { PagePinsLayout } from "./page-pin-reports";

/**
 * The part of `box` inside the viewport, in the device pixels
 * `capturePage` takes, or null when none of it is on screen.
 */
export function screenshotRect(
  box: Box,
  viewport: { width: number; height: number },
  zoomFactor: number,
): Box | null {
  const left = Math.max(0, box.x);
  const top = Math.max(0, box.y);
  const right = Math.min(viewport.width, box.x + box.width);
  const bottom = Math.min(viewport.height, box.y + box.height);
  if (right - left < 1 || bottom - top < 1) return null;
  const x = Math.round(left * zoomFactor);
  const y = Math.round(top * zoomFactor);
  return {
    x,
    y,
    width: Math.max(1, Math.round(right * zoomFactor) - x),
    height: Math.max(1, Math.round(bottom * zoomFactor) - y),
  };
}

/** Screenshot id → its path on this machine. Ids, not paths, cross IPC. */
const shots = new Map<string, string>();
/** Enough for any queue a person builds; past it the oldest go. */
const MAX_SHOTS = 500;

function rememberShot(path: string): string {
  const id = randomUUID();
  shots.set(id, path);
  if (shots.size > MAX_SHOTS) shots.delete(shots.keys().next().value!);
  return id;
}

async function takeScreenshot(
  page: WebContents,
  pick: PickReport,
  registry: Pick<BackendRegistry, "get">,
): Promise<PagePick["screenshot"]> {
  const rect = screenshotRect(pick.boundingBox, pick.viewport, page.getZoomFactor());
  if (!rect) return null;
  try {
    const image = await page.capturePage(rect);
    if (image.isEmpty()) return null;
    const path = await writePastedImage(registry, LOCAL_HOST_ID, image.toPNG(), "png");
    return { id: rememberShot(path), path };
  } catch {
    return null;
  }
}

/**
 * Panes whose page is picking: set by `start-pins`, cleared by `stop-pins`,
 * by the page's own Escape and by a new document. A pick reported while a
 * pane isn't armed is the page talking, not the user clicking, and is dropped.
 */
const armed = new Set<string>();
/** Panes with a screenshot being taken: one at a time, so a page can't flood the disk. */
const capturing = new Set<string>();

/** Whether a console line came from `page`'s main frame; a subframe's are its own. */
function fromMainFrame(page: WebContents, details: { frame?: Electron.WebFrameMain | null }): boolean {
  const frame = details?.frame;
  if (!frame) return false;
  try {
    return frame.frameTreeNodeId === page.mainFrame.frameTreeNodeId;
  } catch {
    // The frame is gone already.
    return false;
  }
}

/**
 * Listen to `page`'s pin reports and pass them, checked, to `host`, the
 * renderer that owns `paneId`. Returns the cleanup.
 */
export function attachPagePins(
  paneId: string,
  page: WebContents,
  host: WebContents,
  registry: Pick<BackendRegistry, "get">,
): () => void {
  const send = (channel: string, ...args: unknown[]) => {
    if (!host.isDestroyed()) host.send(channel, paneId, ...args);
  };
  const release = (pickId: string) => {
    if (!page.isDestroyed()) void page.executeJavaScript(pinsCall("release", pickId)).catch(() => {});
  };

  const listener = (
    details: { message?: string; frame?: Electron.WebFrameMain | null },
    _level?: number,
    legacyMessage?: string,
  ) => {
    const message = details?.message ?? legacyMessage ?? "";
    if (!message.startsWith(PIN_REPORT_PREFIX) || !fromMainFrame(page, details)) return;

    if (message.startsWith(PIN_PICK_PREFIX)) {
      if (!armed.has(paneId)) return;
      const pick = parsePickReport(message.slice(PIN_PICK_PREFIX.length));
      if (!pick) return;
      if (capturing.has(paneId)) {
        // Too quick after the last one: dropped, but its page shows its pins again.
        release(pick.pickId);
        return;
      }
      capturing.add(paneId);
      void takeScreenshot(page, pick, registry).then((screenshot) => {
        capturing.delete(paneId);
        // The pins come back whether or not the capture worked.
        release(pick.pickId);
        const { viewport: _viewport, ...rest } = pick;
        send("webview:pin-picked", { ...rest, screenshot } satisfies PagePick);
      });
    } else if (message === PIN_STOP_MESSAGE) {
      armed.delete(paneId);
      send("webview:pins-stopped");
    } else if (message.startsWith(PIN_OPEN_PREFIX)) {
      const pinId = parsePinOpen(message.slice(PIN_OPEN_PREFIX.length));
      if (pinId) send("webview:pin-opened", pinId);
    } else if (message.startsWith(PINS_PREFIX)) {
      const layout = parsePinsLayout(message.slice(PINS_PREFIX.length));
      if (layout) send("webview:pins-moved", layout);
    }
  };
  // A new document has no pins script, so nothing to pick with.
  const onNavigate = () => armed.delete(paneId);

  page.on("console-message", listener as never);
  page.on("did-navigate", onNavigate);
  return () => {
    armed.delete(paneId);
    capturing.delete(paneId);
    if (!page.isDestroyed()) {
      page.off("console-message", listener as never);
      page.off("did-navigate", onNavigate);
    }
  };
}

function isPinList(value: unknown): value is Array<{ id: string; label: string }> {
  return (
    Array.isArray(value) &&
    value.every(
      (v) => v && typeof v === "object" && typeof v.id === "string" && typeof v.label === "string",
    )
  );
}

/**
 * The renderer's side: start and stop picking, show the pins it numbers, and
 * upload a screenshot to the host an agent will read it on. `pageOf` finds a
 * pane's page.
 */
export function registerPagePinsIpc(
  pageOf: (paneId: string) => WebContents | null,
  registry: Pick<BackendRegistry, "get">,
): void {
  ipcMain.handle(
    "webview:start-pins",
    async (_event, paneId: string, theme: { accent: string; bg: string }) => {
      assertString(paneId, "paneId");
      const page = pageOf(paneId);
      if (!page) return false;
      armed.add(paneId);
      await page.executeJavaScript(PINS_SCRIPT);
      await page.executeJavaScript(
        pinsCall("setTheme", String(theme?.accent ?? ""), String(theme?.bg ?? "")) + pinsCall("start"),
      );
      return true;
    },
  );

  ipcMain.handle("webview:stop-pins", async (_event, paneId: string) => {
    assertString(paneId, "paneId");
    armed.delete(paneId);
    await pageOf(paneId)?.executeJavaScript(pinsCall("stop")).catch(() => {});
  });

  ipcMain.handle("webview:sync-pins", async (_event, paneId: string, list: unknown) => {
    assertString(paneId, "paneId");
    if (!isPinList(list)) throw new Error("list must be { id, label }[]");
    await pageOf(paneId)?.executeJavaScript(pinsCall("sync", list)).catch(() => {});
  });

  // The screenshot's path on `hostId`: this machine's own, or a fresh copy
  // there. Null when the shot is unknown or the upload failed.
  ipcMain.handle("webview:upload-pin-shot", async (_event, shotId: string, hostId?: string | null) => {
    assertString(shotId, "shotId");
    const local = shots.get(shotId);
    if (!local) return null;
    if (!hostId || hostId === LOCAL_HOST_ID) return local;
    try {
      return await writePastedImage(registry, hostId, await readFile(local), "png");
    } catch {
      return null;
    }
  });
}
