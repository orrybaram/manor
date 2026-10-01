import { useState } from "react";
import { PhoneTopBar } from "./PhoneTopBar";
import { SidebarDrawer } from "./SidebarDrawer";
import { PaneSwitcherSheet } from "./PaneSwitcherSheet";

type PhoneChromeProps = {
  onShowAgents: () => void;
  onOpenProjectSettings: (projectId: string) => void;
  onAddProject: () => void;
  /** Opens the command palette. The phone has no palette of its own: this
   *  is the same `CommandPalette` the desk layout opens. */
  onOpenPalette: () => void;
};

/**
 * ADR-181 D3/D4/D5: the phone shell — the top bar, the sidebar drawer it
 * opens and the pane-switcher sheet. `App` renders it through one slot, at
 * the top of the main column. The drawer and the sheet are Radix dialogs
 * that portal under `<body>`, so only the top bar takes a place in the
 * layout: it sits around the workspace stack, not inside it, so nothing
 * about the split components' element tree changes and a pane switch still
 * remounts nothing.
 *
 * With no swipe, the switcher and the tab strip are the only ways a phone
 * moves between panes.
 */
export function PhoneChrome(props: PhoneChromeProps) {
  const { onShowAgents, onOpenProjectSettings, onAddProject, onOpenPalette } = props;

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paneSwitcherOpen, setPaneSwitcherOpen] = useState(false);

  return (
    <>
      <PhoneTopBar
        onToggleDrawer={() => setDrawerOpen((v) => !v)}
        onOpenPaneSwitcher={() => setPaneSwitcherOpen(true)}
        onOpenPalette={onOpenPalette}
      />
      <SidebarDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        onShowAgents={onShowAgents}
        onOpenProjectSettings={onOpenProjectSettings}
        onAddProject={onAddProject}
      />
      <PaneSwitcherSheet
        open={paneSwitcherOpen}
        onOpenChange={setPaneSwitcherOpen}
      />
    </>
  );
}
