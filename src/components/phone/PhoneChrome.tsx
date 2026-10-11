import { useState } from "react";
import { PhoneTopBar } from "./PhoneTopBar";
import { SidebarDrawer } from "./SidebarDrawer";
import { useEdgeSwipeToOpen } from "./useDrawerSwipe";
import { NotificationsSheet } from "./NotificationsSheet";
import { EnableNotifications } from "./EnableNotifications";
import { KeyboardLift } from "./KeyboardLift";
import { useMountEffect } from "../../hooks/useMountEffect";
import { onUiRequest } from "../../utils/ui-request";

type PhoneChromeProps = {
  onNewAgent: () => void;
  onOpenSettings: () => void;
  /** Opens the command palette, unscoped — the same `CommandPalette` the desk
   *  sidebar's Search row opens. The phone has no palette of its own. */
  onOpenSearch: () => void;
  /** Settings, the palette or another app-level dialog is open; the edge swipe
   *  stays out of its way. */
  modalOpen: boolean;
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
 * Swiping right from the left half of the screen opens the drawer too.
 *
 * A phone moves between panes with the tab strip, and to another panel
 * through the palette (Next Pane, Focus Next Panel).
 */
export function PhoneChrome(props: PhoneChromeProps) {
  const {
    onNewAgent,
    onOpenSettings,
    onOpenSearch,
    modalOpen,
  } = props;

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);

  useEdgeSwipeToOpen(() => setDrawerOpen(true), !notificationsOpen && !modalOpen);

  /** Every action the drawer hands out closes it first. */
  const closeThen =
    <A extends unknown[]>(fn: (...args: A) => void) =>
    (...args: A) => {
      setDrawerOpen(false);
      fn(...args);
    };

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
      />
      <EnableNotifications />
      <SidebarDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        onNewAgent={closeThen(onNewAgent)}
        onOpenSettings={closeThen(onOpenSettings)}
        onOpenSearch={closeThen(onOpenSearch)}
        onOpenNotifications={closeThen(() => setNotificationsOpen(true))}
      />
      <NotificationsSheet open={notificationsOpen} onOpenChange={setNotificationsOpen} />
      <KeyboardLift />
    </>
  );
}
