import PanelLeft from "lucide-react/dist/esm/icons/panel-left";
import ArrowLeft from "lucide-react/dist/esm/icons/arrow-left";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right";
import { Button } from "../../ui/Button/Button";
import { Tooltip } from "../../ui/Tooltip/Tooltip";
import { useProjectStore } from "../../../store/project-store";
import { useKeybindingsStore } from "../../../store/keybindings-store";
import { useNavigationHistoryStore } from "../../../store/navigation-history-store";
import {
  navigateBack,
  navigateForward,
} from "../../../hooks/useNavigationHistory";
import { formatCombo, type KeyCombo } from "../../../lib/keybindings";
import { windowLeadWidth } from "../../../lib/window-lead";
import { NotificationsPopover } from "../../notifications/NotificationsPopover";
import styles from "./WindowLead.module.css";

function withShortcut(label: string, combo: KeyCombo | undefined): string {
  return combo ? `${label} (${formatCombo(combo)})` : label;
}

/**
 * The window's top-left controls (ADR-196): room for the macOS traffic
 * lights, the sidebar toggle and back/forward, on the frame and draggable.
 * Sits over the sidebar panel in `full` mode, else over the rail and the
 * top-left panel's tab bar inset.
 */
export function WindowLead() {
  const sidebarMode = useProjectStore((s) => s.sidebarMode);
  const sidebarWidth = useProjectStore((s) => s.sidebarWidth);
  const toggleSidebarRail = useProjectStore((s) => s.toggleSidebarRail);
  const canGoBack = useNavigationHistoryStore((s) => s.canGoBack());
  const canGoForward = useNavigationHistoryStore((s) => s.canGoForward());
  const bindings = useKeybindingsStore((s) => s.bindings);

  const toggleLabel = withShortcut("Toggle sidebar", bindings["toggle-sidebar"]);
  const backLabel = withShortcut("Back", bindings["history-back"]);
  const forwardLabel = withShortcut("Forward", bindings["history-forward"]);

  return (
    <div
      className={styles.lead}
      style={{ width: windowLeadWidth(sidebarMode, sidebarWidth) }}
      data-testid="window-lead"
    >
      <div className={styles.lightsSpacer} />
      <div className={styles.controls}>
        <Tooltip label={toggleLabel}>
          <Button
            variant="ghost"
            size="sm"
            className={styles.button}
            onClick={() => toggleSidebarRail()}
            aria-label="Toggle sidebar"
          >
            <PanelLeft size={12} />
          </Button>
        </Tooltip>
        <Tooltip label={backLabel}>
          <Button
            variant="ghost"
            size="sm"
            className={styles.button}
            onClick={() => navigateBack()}
            disabled={!canGoBack}
            aria-label="Navigate back"
          >
            <ArrowLeft size={12} />
          </Button>
        </Tooltip>
        <Tooltip label={forwardLabel}>
          <Button
            variant="ghost"
            size="sm"
            className={styles.button}
            onClick={() => navigateForward()}
            disabled={!canGoForward}
            aria-label="Navigate forward"
          >
            <ArrowRight size={12} />
          </Button>
        </Tooltip>
      </div>
      {sidebarMode === "full" && (
        <div className={styles.trailing}>
          <NotificationsPopover />
        </div>
      )}
    </div>
  );
}
