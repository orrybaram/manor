import { useState } from "react";
import ChevronLeft from "lucide-react/dist/esm/icons/chevron-left";
import * as Dialog from "@radix-ui/react-dialog";
import { Sidebar } from "../sidebar/Sidebar/Sidebar";
import { Button } from "../ui/Button/Button";
import { PhoneAgentsPanel } from "./AgentsDrawer/PhoneAgentsPanel";
import { useSwipeToClose } from "./useDrawerSwipe";
import styles from "./SidebarDrawer.module.css";

type SidebarDrawerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The agents view's "New agent" button. */
  onNewAgent: () => void;
  /** The agents view's settings button. */
  onOpenSettings: () => void;
  onShowAgents?: () => void;
  onOpenProjectSettings?: (projectId: string) => void;
  onAddProject?: () => void;
  /** The nav group's Search row. */
  onOpenSearch?: () => void;
  /** The nav group's Notifications row (phone only). */
  onOpenNotifications?: () => void;
};

/**
 * ADR-181 D3: in phone mode the sidebar lives in a left-edge drawer
 * instead of inline — inline would eat the whole screen at phone width.
 * Radix `Dialog` supplies most of what a drawer needs: the overlay, Escape
 * and an overlay tap both closing it, a focus trap
 * while open, and — since this is a controlled dialog with no
 * `Dialog.Trigger` of its own — focus returned to whatever had it when the
 * drawer opened (`PhoneTopBar`'s drawer toggle) once it closes.
 *
 * The content is the very same `Sidebar` the desk layout renders inline;
 * moving it between parents remounts it, which costs nothing since it holds
 * no terminals. `onNavigate` is `Sidebar`'s existing workspace-select path —
 * choosing Home or a workspace closes the drawer because the user asked to
 * go somewhere, not because this duplicates that selection logic.
 *
 * ADR-219: the drawer opens on an agents-first view (`PhoneAgentsPanel`);
 * the projects/workspaces `Sidebar` is one tap away behind a back header.
 * The view resets to agents every time the drawer opens.
 */
export function SidebarDrawer(props: SidebarDrawerProps) {
  const {
    open,
    onOpenChange,
    onNewAgent,
    onOpenSettings,
    onShowAgents,
    onOpenProjectSettings,
    onAddProject,
    onOpenSearch,
    onOpenNotifications,
  } = props;
  const swipe = useSwipeToClose(() => onOpenChange(false));

  // Reset on open rather than on close: the sheet stays mounted through its
  // exit animation, and swapping views then would flash. Setting state during
  // render covers closes driven by the parent as well as by `onOpenChange`.
  const [view, setView] = useState<"agents" | "projects">("agents");
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setView("agents");
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          className={styles.sheet}
          data-testid="sidebar-drawer"
          aria-label="Sidebar"
          aria-describedby={undefined}
          {...swipe}
          // Focus the sheet, not its first button: on a phone that button's
          // focus ring (and tooltip) is the first thing the drawer shows.
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement).focus();
          }}
        >
          {/* Radix requires an accessible title; the sidebar's own content
              already carries the visual heading, so this one is hidden. */}
          <Dialog.Title className="sr-only">Sidebar</Dialog.Title>
          {view === "agents" ? (
            <PhoneAgentsPanel
              onNewAgent={onNewAgent}
              onOpenSettings={onOpenSettings}
              onOpenProjects={() => setView("projects")}
              onOpenSearch={onOpenSearch}
              onOpenNotifications={onOpenNotifications}
              onNavigate={() => onOpenChange(false)}
            />
          ) : (
            <div className={styles.projectsView}>
              <div className={styles.backHeader}>
                <Button
                  variant="ghost"
                  className={styles.backButton}
                  data-testid="drawer-back-to-agents"
                  onClick={() => setView("agents")}
                >
                  <ChevronLeft size={18} />
                  Agents
                </Button>
              </div>
              <Sidebar
                onShowAgents={onShowAgents}
                onOpenProjectSettings={onOpenProjectSettings}
                onAddProject={onAddProject}
                onOpenSearch={onOpenSearch}
                onOpenNotifications={onOpenNotifications}
                onNavigate={() => onOpenChange(false)}
              />
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
