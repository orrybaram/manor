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
 * The request names the pane by a random token baked into its shim, and main
 * shows it only if the browser-set origin of the request (its `Origin`, else
 * its referrer) is the origin of a frame in that pane's page: a page that
 * learns another pane's token still can't open a dialog there, nor claim to be
 * another site. Each new document gets a new token (see `DialogTokens`), so a
 * token is worthless once its page is gone. The overlay names the site by that
 * verified origin.
 *
 * Whenever main can't answer (a stale token, an origin it can't verify, a page
 * whose referrer policy sends no referrer, a `Permissions-Policy` that forbids
 * synchronous requests), the shim falls back to the native dialog it replaced,
 * rather than answer for the user. So does a dialog in an out-of-process
 * (cross-site) iframe, which the shim doesn't reach, and one opened before the
 * pane registers.
 */
import { randomUUID } from "node:crypto";
import { ipcMain, protocol, type Session, type WebContents } from "electron";
import { assertString } from "./ipc-validate";
import { clampDialogText, DialogTokens, isPaneOrigin, requestOrigin } from "./page-dialog-guard";

const PAGE_DIALOG_SCHEME = "manor-dialog";

/** One page dialog, as the pane's renderer shows it. */
export interface PageDialog {
  id: string;
  type: "alert" | "confirm" | "prompt";
  message: string;
  /** A `prompt`'s default text; "" for the others. */
  defaultText: string;
  /** The calling frame's origin, as the browser reported it. */
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

/** Where the shim's frames show up in DevTools (and issue locations). */
const PAGE_DIALOG_SHIM_URL = "manor-page-dialogs.js";

/**
 * The shim, closed over `token`. Everything it calls is captured before the
 * page's own scripts run and called through the captured `Reflect.apply`, so
 * a page that patches `XMLHttpRequest`, `JSON` or `Function.prototype.call`
 * later can't see the token or spoof the round-trip. The native dialogs it
 * replaces stay at hand for whenever main doesn't answer: a request that
 * can't be made, or anything but a 200.
 */
function shimSource(token: string): string {
  return `((token) => {
  const apply = Reflect.apply, describe = Object.getOwnPropertyDescriptor;
  const XHR = XMLHttpRequest, proto = XHR.prototype;
  const open = proto.open, send = proto.send;
  const status = describe(proto, "status").get, responseText = describe(proto, "responseText").get;
  const stringify = JSON.stringify, parse = JSON.parse;
  const nativeAlert = window.alert, nativeConfirm = window.confirm, nativePrompt = window.prompt;
  const url = "${PAGE_DIALOG_SCHEME}://" + token + "/";
  // The user's answer, or null when Manor can't give one.
  const ask = (type, message, defaultText) => {
    try {
      const xhr = new XHR();
      apply(open, xhr, ["POST", url, false]);
      apply(send, xhr, [stringify({ type, message, defaultText })]);
      if (apply(status, xhr, []) !== 200) return null;
      const answer = parse(apply(responseText, xhr, []));
      return answer !== null && typeof answer === "object" ? answer : null;
    } catch {
      return null;
    }
  };
  const text = (value) => (value === undefined ? "" : String(value));
  window.alert = function alert(message) {
    if (ask("alert", text(message), "") === null) apply(nativeAlert, window, [message]);
  };
  window.confirm = function confirm(message) {
    const answer = ask("confirm", text(message), "");
    return answer === null ? apply(nativeConfirm, window, [message]) : answer.ok === true;
  };
  window.prompt = function prompt(message, defaultValue) {
    const answer = ask("prompt", text(message), text(defaultValue));
    if (answer === null) return apply(nativePrompt, window, [message, defaultValue]);
    return answer.ok === true ? String(answer.text ?? "") : null;
  };
})(${JSON.stringify(token)});
//# sourceURL=${PAGE_DIALOG_SHIM_URL}`;
}

interface PaneDialogs {
  paneId: string;
  /** The pane's page, whose frames a request's origin must belong to. */
  page: WebContents;
  /** The renderer hosting the pane, which shows the overlay. */
  host: WebContents;
  /** Each open dialog's responder, by dialog id. */
  pending: Map<string, (answer: PageDialogAnswer) => void>;
}

const tokens = new DialogTokens<PaneDialogs>(randomUUID);
/** dialog id → its pane, for the renderer's reply. */
const panesByDialog = new Map<string, PaneDialogs>();
const sessionsHandled = new WeakSet<Session>();

/** The answer, readable only by `origin`. */
function respond(answer: PageDialogAnswer, origin: string): Response {
  return new Response(JSON.stringify(answer), {
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": origin,
    },
  });
}

/** No answer, and one no page may read: the shim falls back to the native dialog. */
function refuse(status: number): Response {
  return new Response(null, { status });
}

/** The origins of every frame in `page`, or none once it's gone. */
function frameOrigins(page: WebContents): string[] {
  if (page.isDestroyed()) return [];
  try {
    return page.mainFrame.framesInSubtree.map((frame) => frame.origin);
  } catch {
    return []; // a frame disposed of mid-walk
  }
}

async function handleDialogRequest(request: Request): Promise<Response> {
  const pane = tokens.resolve(new URL(request.url).hostname);
  if (!pane || pane.host.isDestroyed()) return refuse(404);
  // The page's own word on where it is counts for nothing: only what the
  // browser says, checked against the frames this pane actually shows.
  const origin = requestOrigin(request.headers.get("origin"), request.referrer);
  if (!origin || !isPaneOrigin(origin, frameOrigins(pane.page))) return refuse(403);
  let body: Partial<Pick<PageDialog, "type" | "message" | "defaultText">>;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return refuse(400);
  }
  // One at a time: the page is blocked on it, so another is some other
  // document's, and is answered as dismissed rather than queued up.
  if (pane.pending.size > 0) return respond({ ok: false }, origin);
  const type = body.type === "confirm" || body.type === "prompt" ? body.type : "alert";
  const dialog: PageDialog = {
    id: randomUUID(),
    type,
    message: clampDialogText(String(body.message ?? "")),
    defaultText: type === "prompt" ? clampDialogText(String(body.defaultText ?? "")) : "",
    origin,
  };
  const answer = await new Promise<PageDialogAnswer>((resolve) => {
    pane.pending.set(dialog.id, resolve);
    panesByDialog.set(dialog.id, pane);
    pane.host.send("webview:dialog", pane.paneId, dialog);
  });
  return respond(answer, origin);
}

function settle(pane: PaneDialogs, id: string, answer: PageDialogAnswer): void {
  const resolve = pane.pending.get(id);
  if (!resolve) return;
  pane.pending.delete(id);
  panesByDialog.delete(id);
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
    const pane = panesByDialog.get(id);
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

  const pane: PaneDialogs = { paneId, page, host, pending: new Map() };
  /** The shim script the debugger adds to each new document, once added. */
  let scriptId: string | null = null;
  // Debugger commands run one after another, so a rotation never races the
  // attach or another rotation.
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (step: () => Promise<void>) => {
    queue = queue.then(step).catch((err) => {
      console.warn(`[webview] ${paneId}: page dialogs fall back to native ones:`, err);
    });
  };
  /** The shim for the next document, with a fresh token, in place of the last. */
  const addShim = async (source: string) => {
    const previous = scriptId;
    const added = (await page.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
      source,
    })) as { identifier: string };
    scriptId = added.identifier;
    if (previous !== null) {
      await page.debugger.sendCommand("Page.removeScriptToEvaluateOnNewDocument", {
        identifier: previous,
      });
    }
  };

  const firstSource = shimSource(tokens.issue(pane));
  enqueue(async () => {
    // A pane registered again (its webview re-attached) brings its own token.
    if (page.debugger.isAttached()) page.debugger.detach();
    page.debugger.attach("1.3");
    // Without `Page.enable`, a script added for new documents holds up
    // their load instead of running ahead of it.
    await page.debugger.sendCommand("Page.enable");
    await addShim(firstSource);
    // The document already there (the pane's first page can start before
    // it registers) gets the shim now.
    await page.debugger.sendCommand("Runtime.evaluate", { expression: firstSource });
  });

  // A new document, or a dead renderer, ends the dialogs of the old one, as
  // a browser tab's do. The new document gets a new token; the old one stops
  // working once it has committed.
  const onNavigation = (details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
    if (!details.isMainFrame || details.isSameDocument) return;
    dismissAll(pane);
    const source = shimSource(tokens.issue(pane));
    enqueue(async () => {
      if (page.isDestroyed() || !page.debugger.isAttached()) return;
      await addShim(source);
    });
  };
  const onCommitted = () => tokens.committed(pane);
  const onGone = () => dismissAll(pane);
  page.on("did-start-navigation", onNavigation);
  page.on("did-navigate", onCommitted);
  page.on("render-process-gone", onGone);

  return () => {
    page.off("did-start-navigation", onNavigation);
    page.off("did-navigate", onCommitted);
    page.off("render-process-gone", onGone);
    dismissAll(pane);
    tokens.release(pane);
    if (!page.isDestroyed() && page.debugger.isAttached()) {
      try {
        page.debugger.detach();
      } catch {
        // already gone with its page
      }
    }
  };
}
