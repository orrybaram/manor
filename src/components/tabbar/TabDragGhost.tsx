import { createPortal } from "react-dom";
import Globe from "lucide-react/dist/esm/icons/globe";
import GitCompareArrows from "lucide-react/dist/esm/icons/git-compare-arrows";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../store/app-store";
import { useTabTitle } from "../../hooks/useTabTitle";
import styles from "./TabBar/TabBar.module.css";

type TabDragGhostProps = {
  tabId: string;
  x: number;
  y: number;
};

export function TabDragGhost({ tabId, x, y }: TabDragGhostProps) {
  const title = useTabTitle(tabId);
  const { contentType, favicon } = useAppStore(
    useShallow((s) => {
      const wsPath = s.activeWorkspacePath;
      if (!wsPath) return { contentType: undefined, favicon: undefined };
      const layout = s.workspaceLayouts[wsPath];
      if (!layout) return { contentType: undefined, favicon: undefined };
      for (const panel of Object.values(layout.panels)) {
        const tab = panel.tabs.find((t) => t.id === tabId);
        if (tab)
          return {
            contentType: s.paneContentType[tab.focusedPaneId] as
              | string
              | undefined,
            favicon: s.paneFavicon[tab.focusedPaneId] as string | undefined,
          };
      }
      return { contentType: undefined, favicon: undefined };
    }),
  );

  const isBrowser = contentType === "browser";
  const isDiff = contentType === "diff";
  const contentTypeClass = isDiff ? styles.tabDiff : isBrowser ? styles.tabBrowser : styles.tabTerminal;

  return createPortal(
    <div
      className={`${styles.tabDragGhost} ${contentTypeClass}`}
      style={{
        left: x,
        top: y,
      }}
    >
      {isDiff && <GitCompareArrows size={12} className={styles.tabIcon} />}
      {isBrowser &&
        (favicon ? (
          <img src={favicon} width={12} height={12} className={styles.tabIcon} />
        ) : (
          <Globe size={12} className={styles.tabIcon} />
        ))}
      <span className={styles.tabTitle}>{title}</span>
    </div>,
    document.body,
  );
}
