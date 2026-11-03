/**
 * Docked DevTools for browser panes: one `WebContentsView` per open DevTools,
 * added to the pane's window and laid over the DevTools slot the renderer
 * measures (`BrowserPane/DevToolsDock.tsx`).
 *
 * Why a native view and not a second `<webview>` (#162): on Electron 43+ the
 * DevTools frontend never connects to a `<webview>` host. The guest is pointed
 * at the view with `setDevToolsWebContents`, then opened in `detach` mode,
 * which with a custom host opens no window of its own.
 *
 * Lessons this keeps (from Orca's dock, which found them first):
 *
 * - Each open needs a fresh host: the frontend loads only into a
 *   `webContents` that has never navigated.
 * - `closeDevTools()` leaves a custom host attached and frozen; destroying
 *   the host is what detaches it.
 * - Electron opens nothing for a guest until its old frontend has let go, so
 *   a reopen waits for the previous close to be released.
 * - A guest crash detaches the frontend for good; once the page is back, a
 *   fresh host is put in the same place.
 */
import { WebContentsView, type BrowserWindow, type WebContents } from "electron";
import { toViewBounds, type DockRect } from "../src/lib/devtools-dock";

/** The native view DevTools are shown in. */
export type DockView = WebContentsView;

/** What the dock needs of the window a pane lives in. */
export type DockWindow = Pick<
  BrowserWindow,
  "isDestroyed" | "getContentBounds" | "once" | "off" | "contentView"
>;

export interface BrowserDevToolsDockDeps {
  /** A fresh, never-navigated view. Defaults to `new WebContentsView()`. */
  createView?: () => DockView;
  /** A pane's DevTools opened or closed; tell its renderer. */
  onChange(paneId: string, host: WebContents, open: boolean): void;
  /** A frontend was attached for `paneId`, so its keys can be watched. */
  onFrontend?(paneId: string, frontend: WebContents): void;
}

/** Where a pane's page and its renderer live. */
export interface DockTarget {
  guest: WebContents;
  /** The renderer hosting the pane. */
  host: WebContents;
  window: DockWindow;
}

interface Dock extends DockTarget {
  view: DockView;
  /** `crashed` after the guest's process died; `reconnecting` while a fresh frontend replaces the dead one. */
  phase: "live" | "crashed" | "reconnecting";
  /** Bumped by every bounds update, so a slow snapshot can't hide a view shown after it. */
  generation: number;
  /** Drops the `closed` listener on the window the view is in now. */
  unhookWindow(): void;
  dispose(): void;
}

export class BrowserDevToolsDock {
  private readonly docks = new Map<string, Dock>();
  /** Per guest id: the previous frontend still letting go. */
  private readonly releases = new Map<number, Promise<void>>();
  /** Per pane: the open in flight, so a close (or a newer open) can supersede it. */
  private readonly opening = new Map<string, symbol>();
  private readonly createView: () => DockView;

  constructor(private readonly deps: BrowserDevToolsDockDeps) {
    this.createView = deps.createView ?? (() => new WebContentsView());
  }

  isOpen(paneId: string): boolean {
    return this.docks.has(paneId) || this.opening.has(paneId);
  }

  /** The host renderer `paneId`'s DevTools report to, while open. */
  hostOf(paneId: string): WebContents | undefined {
    return this.docks.get(paneId)?.host;
  }

  /** Open `paneId`'s DevTools docked. False when superseded or the page is gone. */
  async open(paneId: string, target: DockTarget): Promise<boolean> {
    const existing = this.docks.get(paneId);
    if (existing && existing.guest === target.guest && !target.window.isDestroyed()) {
      if (existing.window !== target.window) this.moveToWindow(paneId, existing, target.window);
      existing.host = target.host;
      return true;
    }
    if (existing) await this.release(paneId);

    const token = Symbol(paneId);
    this.opening.set(paneId, token);
    await this.releases.get(target.guest.id);
    if (this.opening.get(paneId) !== token) return false;
    this.opening.delete(paneId);
    if (target.guest.isDestroyed() || target.window.isDestroyed()) return false;

    // Electron ignores a custom host while its own DevTools window exists.
    if (target.guest.isDevToolsOpened()) target.guest.closeDevTools();

    const dock: Dock = {
      ...target,
      view: this.attachView(paneId, target),
      phase: "live",
      generation: 0,
      unhookWindow: () => {},
      dispose: () => {},
    };
    const { guest, window } = target;

    const onCrash = () => {
      dock.phase = "crashed";
    };
    // The page is back after a crash: drop the dead frontend's host. Its
    // `devtools-closed` then brings up a fresh one in the same place.
    const onDomReady = () => {
      if (dock.phase !== "crashed") return;
      dock.phase = "reconnecting";
      this.destroyView(dock.window, dock.view);
    };
    // DevTools closing itself, or its host being destroyed under it.
    const onDevToolsClosed = () => {
      if (dock.phase === "reconnecting") {
        // Electron opens nothing for a guest until its old frontend has let
        // go, which is after this event — so attach on the next turn, as
        // `waitForRelease` does.
        setImmediate(() => {
          if (this.docks.get(paneId) !== dock || guest.isDestroyed()) return;
          dock.phase = "live";
          const stale = dock.view;
          dock.view = this.attachView(paneId, dock);
          // The stale view kept taking bounds while it detached.
          dock.view.setBounds(stale.getBounds());
          dock.view.setVisible(stale.getVisible());
        });
        return;
      }
      void this.close(paneId);
    };
    const onGone = () => void this.close(paneId);

    guest.on("render-process-gone", onCrash);
    guest.on("dom-ready", onDomReady);
    guest.on("devtools-closed", onDevToolsClosed);
    guest.once("destroyed", onGone);
    window.once("closed", onGone);
    dock.unhookWindow = () => {
      if (!window.isDestroyed()) window.off("closed", onGone);
    };
    dock.dispose = () => {
      if (!guest.isDestroyed()) {
        guest.off("render-process-gone", onCrash);
        guest.off("dom-ready", onDomReady);
        guest.off("devtools-closed", onDevToolsClosed);
        guest.off("destroyed", onGone);
      }
      dock.unhookWindow();
    };

    this.docks.set(paneId, dock);
    this.deps.onChange(paneId, dock.host, true);
    return true;
  }

  /** Close `paneId`'s DevTools. Resolves once Electron has let go of the frontend. */
  close(paneId: string): Promise<void> {
    this.opening.delete(paneId);
    return this.release(paneId);
  }

  /**
   * Place `paneId`'s view over `slot` (the host renderer's CSS pixels), or
   * hide it for null. With `snapshot`, the hidden view's last frame comes
   * back as a data URL for the renderer to paint in its place.
   *
   * `window` is the one the report came from: a pane that moved windows
   * takes its view along.
   */
  async setBounds(
    paneId: string,
    window: DockWindow,
    slot: DockRect | null,
    snapshot: boolean,
  ): Promise<string | null> {
    const dock = this.docks.get(paneId);
    if (!dock || window.isDestroyed()) return null;
    if (dock.window !== window) this.moveToWindow(paneId, dock, window);
    const generation = ++dock.generation;

    if (slot) {
      const content = window.getContentBounds();
      const bounds = toViewBounds(slot, dock.host.getZoomFactor(), content);
      if (bounds) {
        dock.view.setBounds(bounds);
        dock.view.setVisible(true);
        return null;
      }
    }

    const frontend = dock.view.webContents;
    const image =
      snapshot && slot === null && dock.view.getVisible() && frontend && !frontend.isDestroyed()
        ? await frontend.capturePage().catch(() => null)
        : null;
    if (dock.generation === generation) dock.view.setVisible(false);
    // JPEG: it only stands in under an overlay, and encodes far faster than PNG.
    return image && !image.isEmpty()
      ? `data:image/jpeg;base64,${image.toJPEG(85).toString("base64")}`
      : null;
  }

  private attachView(paneId: string, target: DockTarget): DockView {
    const view = this.createView();
    // Hidden until the renderer reports where the slot is.
    view.setVisible(false);
    target.window.contentView.addChildView(view);
    target.guest.setDevToolsWebContents(view.webContents);
    // With a custom host `detach` opens no window; `activate: false` leaves
    // focus where it was (the toolbar button, the page).
    target.guest.openDevTools({ mode: "detach", activate: false });
    this.deps.onFrontend?.(paneId, view.webContents);
    return view;
  }

  private moveToWindow(paneId: string, dock: Dock, window: DockWindow): void {
    const onGone = () => void this.close(paneId);
    if (!dock.window.isDestroyed()) dock.window.contentView.removeChildView(dock.view);
    window.contentView.addChildView(dock.view);
    // The old window closing no longer concerns this view.
    dock.unhookWindow();
    window.once("closed", onGone);
    dock.unhookWindow = () => {
      if (!window.isDestroyed()) window.off("closed", onGone);
    };
    dock.window = window;
  }

  private release(paneId: string): Promise<void> {
    const dock = this.docks.get(paneId);
    if (!dock) return Promise.resolve();
    this.docks.delete(paneId);
    dock.dispose();
    if (!dock.host.isDestroyed()) this.deps.onChange(paneId, dock.host, false);

    const guestId = dock.guest.id;
    const released = waitForRelease(dock.guest, dock.view);
    this.releases.set(guestId, released);
    void released.then(() => {
      if (this.releases.get(guestId) === released) this.releases.delete(guestId);
    });
    this.destroyView(dock.window, dock.view);
    return released;
  }

  private destroyView(window: DockWindow, view: DockView): void {
    if (!window.isDestroyed()) window.contentView.removeChildView(view);
    // Electron drops `webContents` off a view whose contents are already gone.
    const frontend = view.webContents as WebContents | null | undefined;
    if (frontend && !frontend.isDestroyed()) frontend.close();
  }
}

/** Resolves once the guest has let go of `view`'s frontend, so DevTools can open again. */
function waitForRelease(guest: WebContents, view: DockView): Promise<void> {
  const frontend = view.webContents as WebContents | null | undefined;
  if (!frontend || frontend.isDestroyed() || guest.isDestroyed()) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      if (!guest.isDestroyed()) {
        guest.off("devtools-closed", done);
        guest.off("destroyed", done);
      }
      // Let the rest of the host's destruction run before anyone reopens.
      setImmediate(resolve);
    };
    guest.once("devtools-closed", done);
    guest.once("destroyed", done);
    // A frontend that closed itself already reported `devtools-closed`.
    frontend.once("destroyed", done);
  });
}
