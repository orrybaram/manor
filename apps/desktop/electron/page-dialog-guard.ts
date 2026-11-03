/**
 * The checks a page dialog request must pass before it reaches a pane's
 * overlay, kept free of Electron so they can be tested on their own. See
 * webview-dialogs.ts for the mechanism they guard.
 */

/** The most of a dialog's message or default text that leaves main. */
export const MAX_DIALOG_TEXT = 4096;

/** `text`, cut to `MAX_DIALOG_TEXT` characters. */
export function clampDialogText(text: string): string {
  return text.length > MAX_DIALOG_TEXT ? `${text.slice(0, MAX_DIALOG_TEXT)}…` : text;
}

/**
 * The origin of the document that sent a dialog request, as the browser (not
 * the page) says it: the `Origin` header if there is one, else the origin of
 * the request's referrer. Null when neither names a tuple origin: a page whose
 * referrer policy sends none, or an opaque origin, can't be told apart from
 * any other page.
 */
export function requestOrigin(originHeader: string | null, referrer: string): string | null {
  for (const source of [originHeader, referrer]) {
    if (!source || source === "null") continue;
    try {
      const { origin } = new URL(source);
      if (origin && origin !== "null") return origin;
    } catch {
      // not a URL: try the next
    }
  }
  return null;
}

/** Whether `origin` is the origin of one of the frames in the pane's page. */
export function isPaneOrigin(origin: string, frameOrigins: readonly string[]): boolean {
  return frameOrigins.includes(origin);
}

/**
 * Each pane's shim tokens. Every new document gets a fresh token (`issue`, at
 * the start of a main-frame navigation); once it commits (`committed`), the
 * tokens before it stop working, so a token read out of one document is
 * useless after the user has navigated away from it. Until then the old
 * document keeps its own: a navigation that never commits (a download, a 204)
 * leaves the page where it was.
 */
export class DialogTokens<P> {
  private readonly panes = new Map<string, P>();
  private readonly tokens = new Map<P, { current: string; live: Set<string> }>();

  constructor(private readonly mint: () => string) {}

  /** A new token for `pane`'s next document; its older ones still work. */
  issue(pane: P): string {
    const token = this.mint();
    const entry = this.tokens.get(pane);
    if (entry) {
      entry.current = token;
      entry.live.add(token);
    } else {
      this.tokens.set(pane, { current: token, live: new Set([token]) });
    }
    this.panes.set(token, pane);
    return token;
  }

  /** `pane`'s newest document committed: every older token stops working. */
  committed(pane: P): void {
    const entry = this.tokens.get(pane);
    if (!entry) return;
    for (const token of entry.live) {
      if (token !== entry.current) this.panes.delete(token);
    }
    entry.live = new Set([entry.current]);
  }

  /** The pane `token` belongs to, while it still works. */
  resolve(token: string): P | undefined {
    return this.panes.get(token);
  }

  /** Every token of `pane` stops working. */
  release(pane: P): void {
    const entry = this.tokens.get(pane);
    if (!entry) return;
    for (const token of entry.live) this.panes.delete(token);
    this.tokens.delete(pane);
  }
}
