/**
 * A browser pane's `alert` / `confirm` / `prompt`, answered by an overlay in
 * the pane instead of a native message box.
 *
 * Electron gives an embedder no say over a guest's dialogs: `<webview>` and
 * `webContents` have no `dialog` event, and Electron's own dialog manager
 * shows `alert`/`confirm` as a native box modal to the whole window (so all
 * of Manor stops) and answers `prompt` with `null` before anyone sees it. The
 * DevTools protocol's `Page.handleJavaScriptDialog` can't help either: that
 * manager still runs alongside it, and has already answered a `prompt`.
 *
 * So the page never reaches the native dialogs. Through the guest's debugger,
 * a shim goes into every document before the page's own scripts run
 * (`Page.addScriptToEvaluateOnNewDocument`) and replaces the three functions.
 * Each one makes a *synchronous* request to the `manor-dialog:` scheme, which
 * blocks only the page's own renderer, exactly as a real dialog does, and so
 * keeps their return values synchronous. Main's handler for the scheme asks
 * the pane's renderer to show the overlay and responds with the user's
 * answer. The console channel the picker uses can't do this: it only carries
 * messages out of the page, and `confirm` must wait for its answer.
 *
 * The request names the pane by a random per-pane token baked into its shim,
 * so a page can only ever open a dialog in its own pane. A dialog in an
 * out-of-process (cross-site) iframe is not reached by the shim and falls
 * through to Electron's native one.
 */
import { randomUUID } from "node:crypto";
import { ipcMain, protocol, type Session, type WebContents } from "electron";
import { assertString } from "./ipc-validate";

const PAGE_DIALOG_SCHEME = "manor-dialog";

/** One page dialog, as the pane's renderer shows it. */
export interface PageDialog {
  id: string;
  type: "alert" | "confirm" | "prompt";
  message: string;
  /** A `prompt`'s default text; "" for the others. */
  defaultText: string;
  /** The calling frame's origin (or URL, for an opaque origin). */
  origin: string;
}

interface PageDialogAnswer {
  ok: boolean;
  text?: string;
}

/**
 * Before `app` is ready: the shim's synchronous request must get past the
 * page's CSP (`bypassCSP`) and be answerable cross-origin (`corsEnabled`).
 */
export function registerPageDialogScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PAGE_DIALOG_SCHEME,
      privileges: { standard: true, secure: true, bypassCSP: true, corsEnabled: true, supportFetchAPI: true },
    },
  ]);
}

/**
 * The shim, closed over `token`. It keeps its own references to
 * `XMLHttpRequest` and `JSON` so a page that patches them later can't see or
 * spoof the round-trip. A request that can't be made (a page being unloaded
 * may not block) reads as a dismissed dialog.
 */
function shimSource(token: string): string {
  return `((token) => {
  const XHR = XMLHttpRequest, open = XHR.prototype.open, send = XHR.prototype.send;
  const stringify = JSON.stringify, parse = JSON.parse;
  const ask = (type, message, defaultText) => {
    try {
      const xhr = new XHR();
      open.call(xhr, "POST", "${PAGE_DIALOG_SCHEME}://" + token + "/", false);
      const origin = location.origin !== "null" ? location.origin : location.href;
      send.call(xhr, stringify({ type, message, defaultText, origin }));
      return parse(xhr.responseText);
    } catch {
      return { ok: false };
    }
  };
  const text = (value) => (value === undefined ? "" : String(value));
  window.alert = function alert(message) { ask("alert", text(message), ""); };
  window.confirm = function confirm(message) { return ask("confirm", text(message), "").ok === true; };
  window.prompt = function prompt(message, defaultValue) {
    const answer = ask("prompt", text(message), text(defaultValue));
    return answer.ok === true ? String(answer.text ?? "") : null;
  };
})(${JSON.stringify(token)});`;
}

interface PaneDialogs {
  paneId: string;
  /** The renderer hosting the pane, which shows the overlay. */
  host: WebContents;
  /** Each open dialog's responder, by dialog id. */
  pending: Map<string, (answer: PageDialogAnswer) => void>;
}

/** token → the pane its shim belongs to. */
const panesByToken = new Map<string, PaneDialogs>();
/** dialog id → its pane's token, for the renderer's reply. */
const tokensByDialog = new Map<string, string>();
const sessionsHandled = new WeakSet<Session>();

function respond(answer: PageDialogAnswer, status = 200): Response {
  return new Response(JSON.stringify(answer), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    },
  });
}

async function handleDialogRequest(request: Request): Promise<Response> {
  const token = new URL(request.url).hostname;
  const pane = panesByToken.get(token);
  if (!pane || pane.host.isDestroyed()) return respond({ ok: false }, 404);
  let body: Partial<Omit<PageDialog, "id">>;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return respond({ ok: false }, 400);
  }
  const type = body.type === "confirm" || body.type === "prompt" ? body.type : "alert";
  const dialog: PageDialog = {
    id: randomUUID(),
    type,
    message: String(body.message ?? ""),
    defaultText: type === "prompt" ? String(body.defaultText ?? "") : "",
    origin: String(body.origin ?? ""),
  };
  const answer = await new Promise<PageDialogAnswer>((resolve) => {
    pane.pending.set(dialog.id, resolve);
    tokensByDialog.set(dialog.id, token);
    pane.host.send("webview:dialog", pane.paneId, dialog);
  });
  return respond(answer);
}

function settle(pane: PaneDialogs, id: string, answer: PageDialogAnswer): void {
  const resolve = pane.pending.get(id);
  if (!resolve) return;
  pane.pending.delete(id);
  tokensByDialog.delete(id);
  resolve(answer);
}

/** Dismiss every dialog open in the pane, and take its overlay down. */
function dismissAll(pane: PaneDialogs): void {
  for (const id of [...pane.pending.keys()]) {
    settle(pane, id, { ok: false });
    if (!pane.host.isDestroyed()) pane.host.send("webview:dialog-closed", pane.paneId, id);
  }
}

/** The renderer's answer to one dialog. Registered once, with the other webview IPC. */
export function registerPageDialogIpc(): void {
  ipcMain.handle("webview:dialog-reply", (_event, id: string, ok: boolean, text?: string) => {
    assertString(id, "id");
    const token = tokensByDialog.get(id);
    const pane = token ? panesByToken.get(token) : undefined;
    if (!pane) return;
    settle(pane, id, { ok: ok === true, text: typeof text === "string" ? text : undefined });
  });
}

/**
 * Route `page`'s dialogs to the overlay in `paneId`, shown by `host`. Returns
 * the cleanup, which dismisses any dialog still open.
 */
export function attachPageDialogs(paneId: string, page: WebContents, host: WebContents): () => void {
  if (!sessionsHandled.has(page.session)) {
    sessionsHandled.add(page.session);
    page.session.protocol.handle(PAGE_DIALOG_SCHEME, handleDialogRequest);
  }

  const token = randomUUID();
  const pane: PaneDialogs = { paneId, host, pending: new Map() };
  panesByToken.set(token, pane);
  const source = shimSource(token);

  void (async () => {
    try {
      // A pane registered again (its webview re-attached) brings its own token.
      if (page.debugger.isAttached()) page.debugger.detach();
      page.debugger.attach("1.3");
      // Without `Page.enable`, a script added for new documents holds up
      // their load instead of running ahead of it.
      await page.debugger.sendCommand("Page.enable");
      await page.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source });
      // The document already there (the pane's first page can start before
      // it registers) gets the shim now.
      await page.debugger.sendCommand("Runtime.evaluate", { expression: source });
    } catch (err) {
      console.warn(`[webview] ${paneId}: page dialogs fall back to native ones:`, err);
    }
  })();

  // A new document, or a dead renderer, ends the dialogs of the old one, as
  // a browser tab's do.
  const onNavigation = (details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
    if (details.isMainFrame && !details.isSameDocument) dismissAll(pane);
  };
  const onGone = () => dismissAll(pane);
  page.on("did-start-navigation", onNavigation);
  page.on("render-process-gone", onGone);

  return () => {
    page.off("did-start-navigation", onNavigation);
    page.off("render-process-gone", onGone);
    dismissAll(pane);
    panesByToken.delete(token);
    if (!page.isDestroyed() && page.debugger.isAttached()) {
      try {
        page.debugger.detach();
      } catch {
        // already gone with its page
      }
    }
  };
}
