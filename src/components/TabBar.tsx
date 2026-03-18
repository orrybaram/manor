import { useAppStore } from "../store/app-store";
import { allPaneIds } from "../store/pane-tree";

function useTabTitle(tabId: string): string {
  const tab = useAppStore((s) => s.tabs.find((t) => t.id === tabId));
  const paneCwd = useAppStore((s) => s.paneCwd);
  if (!tab) return "Terminal";
  // Show CWD of the focused pane, or fall back to tab title
  const cwd = paneCwd[tab.focusedPaneId];
  if (cwd) {
    const parts = cwd.split("/");
    return parts[parts.length - 1] || parts[parts.length - 2] || cwd;
  }
  // Try any pane in the tab
  const ids = allPaneIds(tab.rootNode);
  for (const id of ids) {
    const c = paneCwd[id];
    if (c) {
      const parts = c.split("/");
      return parts[parts.length - 1] || parts[parts.length - 2] || c;
    }
  }
  return tab.title;
}

function TabButton({
  tabId,
  isActive,
  canClose,
  onSelect,
  onClose,
}: {
  tabId: string;
  isActive: boolean;
  canClose: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const title = useTabTitle(tabId);
  return (
    <button
      className={`tab ${isActive ? "tab-active" : ""}`}
      onClick={onSelect}
    >
      <span className="tab-title">{title}</span>
      {canClose && (
        <span
          className="tab-close"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
        >
          ×
        </span>
      )}
    </button>
  );
}

export function TabBar() {
  const tabs = useAppStore((s) => s.tabs);
  const selectedTabId = useAppStore((s) => s.selectedTabId);
  const selectTab = useAppStore((s) => s.selectTab);
  const addTab = useAppStore((s) => s.addTab);
  const closeTab = useAppStore((s) => s.closeTab);

  return (
    <div className="tab-bar" data-tauri-drag-region>
      <div className="tab-bar-tabs">
        {tabs.map((tab) => (
          <TabButton
            key={tab.id}
            tabId={tab.id}
            isActive={tab.id === selectedTabId}
            canClose={tabs.length > 1}
            onSelect={() => selectTab(tab.id)}
            onClose={() => closeTab(tab.id)}
          />
        ))}
      </div>
      <button className="tab-add" onClick={addTab}>
        +
      </button>
    </div>
  );
}
