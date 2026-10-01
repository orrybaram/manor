import * as Dialog from "@radix-ui/react-dialog";
import { Sidebar } from "../sidebar/Sidebar/Sidebar";
import styles from "./SidebarDrawer.module.css";

type SidebarDrawerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onShowAgents?: () => void;
  onOpenProjectSettings?: (projectId: string) => void;
  onAddProject?: () => void;
};

/**
 * ADR-181 D3/ticket 4: in phone mode the sidebar lives in a left-edge drawer
 * instead of inline — inline would eat the whole screen at phone width
 * (ticket 3). Radix `Dialog` supplies everything the ticket asks for on its
 * own: the overlay, Escape and an overlay tap both closing it, a focus trap
 * while open, and — since this is a controlled dialog with no
 * `Dialog.Trigger` of its own — focus returned to whatever had it when the
 * drawer opened (`PhoneTopBar`'s drawer toggle) once it closes.
 *
 * The content is the very same `Sidebar` the desk layout renders inline;
 * moving it between parents remounts it, which costs nothing since it holds
 * no terminals. `onNavigate` is `Sidebar`'s existing workspace-select path —
 * choosing Home or a workspace closes the drawer because the user asked to
 * go somewhere, not because this duplicates that selection logic.
 */
export function SidebarDrawer(props: SidebarDrawerProps) {
  const { open, onOpenChange, onShowAgents, onOpenProjectSettings, onAddProject } =
    props;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          className={styles.sheet}
          data-testid="sidebar-drawer"
          aria-label="Sidebar"
        >
          {/* Radix requires an accessible title; the sidebar's own content
              already carries the visual heading, so this one is hidden. */}
          <Dialog.Title className="sr-only">Sidebar</Dialog.Title>
          <Sidebar
            onShowAgents={onShowAgents}
            onOpenProjectSettings={onOpenProjectSettings}
            onAddProject={onAddProject}
            onNavigate={() => onOpenChange(false)}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
