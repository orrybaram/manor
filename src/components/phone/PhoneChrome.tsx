import { useState } from "react";
import { PhoneTopBar } from "./PhoneTopBar";
import { SidebarDrawer } from "./SidebarDrawer";
import { useSwipeToOpenDrawer } from "./useDrawerSwipe";
import { NotificationsSheet } from "./NotificationsSheet";
import { HostsSheet } from "./HostsSheet/HostsSheet";
import { isWebApp } from "../../lib/platform";
import { EnableNotifications } from "./EnableNotifications";
import { KeyboardLift } from "./KeyboardLift";
import { RenameDialog, type RenameTarget } from "./RenameDialog";
import { useMountEffect } from "../../hooks/useMountEffect";
import { onUiRequest, type UiRequest } from "../../utils/ui-request";
import { useAgentStore } from "../../store/agent-store";
import { useProjectStore } from "../../store/project-store";

type PhoneChromeProps = {
  onNewAgent: () => void;
  onOpenSettings: () => void;
  /** Opens the command palette, unscoped — the same `CommandPalette` the desk
   *  sidebar's Search row opens. The phone has no palette of its own. */
  onOpenSearch: () => void;
};

/** What a rename request names, with the name it starts from; null when it
 *  names nothing that exists. */
function renameTarget(request: UiRequest): RenameTarget | null {
  if (request.type === "rename-agent") {
    const agent = useAgentStore
      .getState()
      .agents.find((a) => a.id === request.agentId);
    if (!agent) return null;
    return { kind: "agent", agentId: agent.id, name: agent.name ?? "" };
  }
  if (request.type === "rename-workspace") {
    const ws = useProjectStore
      .getState()
      .projects.find((p) => p.id === request.projectId)
      ?.workspaces.find((w) => w.path === request.path);
    if (!ws) return null;
    return {
      kind: "workspace",
      projectId: request.projectId,
      path: request.path,
      name: ws.name || ws.branch || "",
    };
  }
  return null;
}

/**
 * The phone shell — the top bar, the sidebar drawer it
 * opens, and the notifications and (in a browser) hosts sheets the drawer
 * opens. `App` renders it
 * through one slot, at the top of the main column. The drawer and the sheet
 * are Radix dialogs that portal under `<body>`, so only the top bar takes a
 * place in the layout: it sits around the workspace stack, not inside it, so
 * nothing about the split components' element tree changes and a pane
 * switch still remounts nothing.
 *
 * Swiping right from the left half of the screen opens the drawer too.
 *
 * It also owns the phone's one rename prompt, for a tab's long-press menu
 * and the palette's Rename Workspace — the desk answers the latter inline in
 * the sidebar, which a phone doesn't mount.
 *
 * A phone moves between panes with the tab strip, and to another panel
 * through the palette (Next Pane, Focus Next Panel).
 */
export function PhoneChrome(props: PhoneChromeProps) {
  const {
    onNewAgent,
    onOpenSettings,
    onOpenSearch,
  } = props;

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [hostsOpen, setHostsOpen] = useState(false);
  // Pairings are a browser's: the desktop window is the machine itself.
  const web = isWebApp();
  const [renaming, setRenaming] = useState<RenameTarget | null>(null);

  useSwipeToOpenDrawer(() => setDrawerOpen(true));

  /** Every action the drawer hands out closes it first. */
  const closeThen =
    <A extends unknown[]>(fn: (...args: A) => void) =>
    (...args: A) => {
      setDrawerOpen(false);
      fn(...args);
    };

  // A pushed notification asks for the history. On a phone neither
  // the window lead nor the rail — the desk's popover owners — is mounted, so
  // the sheet answers it alone. Likewise a rename: the sidebar that answers
  // it on the desk isn't mounted here.
  useMountEffect(() =>
    onUiRequest((request) => {
      if (request.type === "open-notifications") {
        setDrawerOpen(false);
        setNotificationsOpen(true);
        return;
      }
      const target = renameTarget(request);
      if (!target) return;
      setDrawerOpen(false);
      setRenaming(target);
    }),
  );

  return (
    <>
      <PhoneTopBar
        onToggleDrawer={() => setDrawerOpen((v) => !v)}
      />
      <EnableNotifications />
      <SidebarDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        onNewAgent={closeThen(onNewAgent)}
        onOpenSettings={closeThen(onOpenSettings)}
        onOpenSearch={closeThen(onOpenSearch)}
        onOpenNotifications={closeThen(() => setNotificationsOpen(true))}
        onOpenHosts={web ? closeThen(() => setHostsOpen(true)) : undefined}
      />
      <NotificationsSheet open={notificationsOpen} onOpenChange={setNotificationsOpen} />
      {web && <HostsSheet open={hostsOpen} onOpenChange={setHostsOpen} />}
      {renaming && (
        <RenameDialog
          key={renaming.kind === "agent" ? renaming.agentId : renaming.path}
          target={renaming}
          onDone={() => setRenaming(null)}
        />
      )}
      <KeyboardLift />
    </>
  );
}
