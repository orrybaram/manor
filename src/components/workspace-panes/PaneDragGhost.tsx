import { createPortal } from "react-dom";
import Globe from "lucide-react/dist/esm/icons/globe";
import GitCompareArrows from "lucide-react/dist/esm/icons/git-compare-arrows";
import Terminal from "lucide-react/dist/esm/icons/terminal";
import { useAppStore } from "../../store/app-store";
import styles from "./PaneLayout/PaneLayout.module.css";

type PaneDragGhostProps = {
  paneId: string;
  x: number;
  y: number;
};

export function PaneDragGhost({ paneId, x, y }: PaneDragGhostProps) {
  const contentType = useAppStore((s) => s.paneContentType[paneId]);
  const paneTitle = useAppStore((s) => s.paneTitle[paneId]);
  const paneCwd = useAppStore((s) => s.paneCwd[paneId]);
  const paneUrl = useAppStore((s) => s.paneUrl[paneId]);
  const favicon = useAppStore((s) => s.paneFavicon[paneId]);

  const isBrowser = contentType === "browser";
  const isDiff = contentType === "diff";

  let label: string;
  if (isDiff) {
    label = "Diff";
  } else if (isBrowser) {
    label = paneTitle || (paneUrl ? paneUrl.replace(/^https?:\/\//, "") : "Browser");
  } else if (paneTitle) {
    const cwdMatch = paneTitle.match(/^.+@.+:(.+)$/);
    if (cwdMatch) {
      const parts = cwdMatch[1].replace(/\/+$/, "").split("/");
      label = parts[parts.length - 1] || paneTitle;
    } else {
      label = paneTitle;
    }
  } else if (paneCwd) {
    const parts = paneCwd.split("/");
    label = parts[parts.length - 1] || parts[parts.length - 2] || paneCwd;
  } else {
    label = "Terminal";
  }

  return createPortal(
    <div
      className={styles.paneDragGhost}
      style={{ left: x, top: y }}
    >
      {isDiff && <GitCompareArrows size={12} />}
      {isBrowser && (favicon ? (
        <img src={favicon as string} width={12} height={12} style={{ flexShrink: 0, opacity: 0.6 }} />
      ) : (
        <Globe size={12} />
      ))}
      {!isDiff && !isBrowser && <Terminal size={12} />}
      <span className={styles.paneDragGhostTitle}>{label}</span>
    </div>,
    document.body,
  );
}
