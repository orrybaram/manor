import { useState } from "react";
import { PhoneTopBar } from "./PhoneTopBar";
import { SidebarDrawer } from "./SidebarDrawer";
import { NotificationsSheet } from "./NotificationsSheet";
import { EnableNotifications } from "./EnableNotifications";
import { KeyboardLift } from "./KeyboardLift";
import { useMountEffect } from "../../hooks/useMountEffect";
import { onUiRequest } from "../../utils/ui-request";

type PhoneChromeProps = {
  onShowAgents: () => void;
  onOpenProjectSettings: (projectId: string) => void;
  onAddProject: () => void;
  /** Opens the command palette. The phone has no palette of its own: this
   *  is the same `CommandPalette` the desk layout opens. */
  onOpenPalette: () => void;
  /** Opens the same palette as the desk sidebar's Search row does, unscoped. */
  onOpenSearch: () => void;
};

/**
 * ADR-181 D3/D5: the phone shell — the top bar, the sidebar drawer it
 * opens, and the notifications sheet the drawer opens. `App` renders it
 * through one slot, at the top of the main column. The drawer and the sheet
 * are Radix dialogs that portal under `<body>`, so only the top bar takes a
 * place in the layout: it sits around the workspace stack, not inside it, so
 * nothing about the split components' element tree changes and a pane
 * switch still remounts nothing.
 *
 * A phone moves between panes with the tab strip, and to another panel
 * through the palette (Next Pane, Focus Next Panel).
 */
export function PhoneChrome(props: PhoneChromeProps) {
  const { onShowAgents, onOpenProjectSettings, onAddProject, onOpenPalette, onOpenSearch } =
    props;

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);

  // A pushed notification asks for the history (ADR-162). On a phone neither
  // the window lead nor the rail — the desk's popover owners — is mounted, so
  // the sheet answers it alone.
  useMountEffect(() =>
    onUiRequest((request) => {
      if (request.type !== "open-notifications") return;
      setDrawerOpen(false);
      setNotificationsOpen(true);
    }),
  );

  return (
    <>
      <PhoneTopBar
        onToggleDrawer={() => setDrawerOpen((v) => !v)}
        onOpenPalette={onOpenPalette}
      />
      <EnableNotifications />
      <SidebarDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        onShowAgents={onShowAgents}
        onOpenProjectSettings={onOpenProjectSettings}
        onAddProject={onAddProject}
        onOpenSearch={() => {
          setDrawerOpen(false);
          onOpenSearch();
        }}
        onOpenNotifications={() => {
          setDrawerOpen(false);
          setNotificationsOpen(true);
        }}
      />
      <NotificationsSheet open={notificationsOpen} onOpenChange={setNotificationsOpen} />
      <KeyboardLift />
    </>
  );
}
