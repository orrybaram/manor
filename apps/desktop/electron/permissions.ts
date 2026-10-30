/**
 * Installs `permission-policy.ts` on every Electron session: the default one
 * (Manor's windows, browser panes, their popups) and any created later.
 * Without this Electron grants every permission to every page.
 *
 * Manor's own windows are known by identity — `trustAppWindow` is called on
 * each `WebContents` `window.ts` creates — and only while the asking frame
 * is the app's renderer, so a guest, a popup, or an app window that somehow
 * navigated away gets the page policy instead.
 *
 * A prompt is a native dialog on the window the page sits in, which a page
 * cannot draw over or imitate.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, dialog, session, type Session, type WebContents } from "electron";

import { createPermissionPolicy, type PermissionPolicy, type PromptRequest } from "./permission-policy";

/** `WebContents` ids of Manor's own windows. */
const appWindowIds = new Set<number>();

/** Mark `wc` as one of Manor's own windows, for as long as it lives. */
export function trustAppWindow(wc: WebContents): void {
  const id = wc.id;
  appWindowIds.add(id);
  wc.once("destroyed", () => appWindowIds.delete(id));
}

/** The bundled renderer `window.ts` loads when there is no dev server. */
const RENDERER_FILE = path.join(__dirname, "../dist/index.html");

/** Whether `url` is the app's renderer: the dev server, or the bundled file. */
function isRendererUrl(url: string): boolean {
  const devServer = process.env.VITE_DEV_SERVER_URL;
  try {
    const parsed = new URL(url);
    if (devServer) return parsed.origin === new URL(devServer).origin;
    return parsed.protocol === "file:" && path.resolve(fileURLToPath(parsed)) === RENDERER_FILE;
  } catch {
    return false;
  }
}

function isAppWindow(wc: WebContents | null, requestingUrl: string): boolean {
  return wc !== null && appWindowIds.has(wc.id) && isRendererUrl(requestingUrl);
}

/** The window a page sits in: its embedder's for a `<webview>` guest. */
function windowOf(wc: WebContents | null): BrowserWindow | null {
  if (!wc || wc.isDestroyed()) return null;
  return BrowserWindow.fromWebContents(wc.hostWebContents ?? wc);
}

async function showPrompt(wc: WebContents | null, request: PromptRequest): Promise<boolean> {
  const options: Electron.MessageBoxOptions = {
    type: "question",
    buttons: ["Block", "Allow"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    message: `${request.site} wants to ${request.action}`,
    detail: `Asked by ${request.origin}. Manor remembers your answer until you quit.`,
  };
  const win = windowOf(wc);
  const { response } = win
    ? await dialog.showMessageBox(win, options)
    : await dialog.showMessageBox(options);
  return response === 1;
}

/**
 * The URL a permission check is about. Electron leaves `requestingUrl` out of
 * some checks and passes only an origin (`file://` for the bundled renderer);
 * then the asking frame's own URL stands in, when it has that origin.
 */
function checkedUrl(
  wc: WebContents | null,
  requestingOrigin: string,
  requestingUrl: string | undefined,
): string {
  if (requestingUrl) return requestingUrl;
  const frameUrl = wc && !wc.isDestroyed() ? wc.getURL() : "";
  try {
    const parsed = new URL(frameUrl);
    const origin = parsed.protocol === "file:" ? "file://" : parsed.origin;
    if (origin === requestingOrigin) return frameUrl;
  } catch {
    // No usable frame URL; fall back to the origin.
  }
  return requestingOrigin;
}

function install(ses: Session, policy: PermissionPolicy<WebContents | null>): void {
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const ask = {
      permission,
      requestingUrl: details.requestingUrl ?? "",
      mediaTypes: "mediaTypes" in details ? details.mediaTypes : undefined,
      externalUrl: "externalURL" in details ? details.externalURL : undefined,
    };
    policy.request(wc, ask).then(callback, () => callback(false));
  });
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin, details) =>
    policy.check(wc, {
      permission,
      requestingUrl: checkedUrl(wc, requestingOrigin, details.requestingUrl),
      mediaType: details.mediaType,
    }),
  );
  // WebHID, WebUSB, Web Serial: nothing in Manor uses them.
  ses.setDevicePermissionHandler(() => false);
}

/** Install the policy on the default session and every session made later. */
export function installPermissionPolicy(): void {
  // One policy for the whole app, so an answer holds wherever the site asks
  // from.
  const policy = createPermissionPolicy<WebContents | null>({
    isAppWindow,
    prompt: showPrompt,
  });
  install(session.defaultSession, policy);
  app.on("session-created", (ses) => install(ses, policy));
}
