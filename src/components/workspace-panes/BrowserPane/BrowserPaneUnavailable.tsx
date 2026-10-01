import { forwardRef, useImperativeHandle } from "react";
import { useDragOverlayStore, selectIsDragActive } from "../../../store/drag-overlay-store";
import { Link } from "../../ui/Link/Link";
import type { BrowserPaneRef } from "./BrowserPane";

import styles from "./BrowserPane.module.css";

type BrowserPaneUnavailableProps = {
  initialUrl: string;
};

const noop = () => {};

/** Every `BrowserPaneRef` method, doing nothing: there is no `<webview>`. */
const UNAVAILABLE_REF: BrowserPaneRef = {
  goBack: noop,
  goForward: noop,
  reload: noop,
  stop: noop,
  startPicker: noop,
  cancelPicker: noop,
  navigate: noop,
  focusUrlInput: noop,
  zoomIn: noop,
  zoomOut: noop,
  zoomReset: noop,
  findInPage: noop,
  stopFind: noop,
  toggleFindBar: noop,
  toggleMute: noop,
  stopRecording: noop,
  getUrlInputValue: () => "",
  urlInputHandlers: {
    onChange: noop,
    onKeyDown: noop,
    onBlur: noop,
    onFocus: noop,
  },
  onSuggestionMouseDown: noop,
};

/**
 * What the web app mounts in place of `BrowserPane` (ADR-178, ADR-182 D11).
 * `<webview>` is Electron-only — a page cannot embed *and* script an
 * arbitrary cross-origin site — so this pane says so instead of mounting
 * nothing, and a `<Link>` opens the same URL in an actual browser tab, which
 * is the desktop app's own popup-window escape hatch (`window.open`), just
 * without Electron in the loop. Its ref answers every `BrowserPaneRef` call
 * with a no-op, so nothing reaches `UNAVAILABLE_NAMESPACES`.
 */
export const BrowserPaneUnavailable = forwardRef<BrowserPaneRef, BrowserPaneUnavailableProps>(
  function BrowserPaneUnavailable(props: BrowserPaneUnavailableProps, ref) {
    const { initialUrl } = props;

    const isDragActive = useDragOverlayStore(selectIsDragActive);

    useImperativeHandle(ref, () => UNAVAILABLE_REF, []);

    const hasUrl = Boolean(initialUrl) && initialUrl !== "about:blank";

    return (
      <div className={styles.container}>
        <div className={styles.webviewContainer}>
          <div className={styles.webUnavailable} data-testid="browser-pane-web-unavailable">
            <p className={styles.webUnavailableMessage}>
              Browser panes need the desktop app.
            </p>
            {hasUrl && (
              <Link href={initialUrl} className={styles.webUnavailableLink}>
                Open {initialUrl} in a new tab
              </Link>
            )}
          </div>
          {isDragActive && <div className={styles.dragOverlay} />}
        </div>
      </div>
    );
  },
);
