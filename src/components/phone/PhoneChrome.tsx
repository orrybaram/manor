import { useState } from "react";
import { PhoneTopBar } from "./PhoneTopBar";
import { SidebarDrawer } from "./SidebarDrawer";
import { EnableNotifications } from "./EnableNotifications";
import { KeyboardLift } from "./KeyboardLift";

type PhoneChromeProps = {
  onShowAgents: () => void;
  onOpenProjectSettings: (projectId: string) => void;
  onAddProject: () => void;
  /** Opens the command palette. The phone has no palette of its own: this
   *  is the same `CommandPalette` the desk layout opens. */
  onOpenPalette: () => void;
};

/**
 * ADR-181 D3/D5: the phone shell — the top bar and the sidebar drawer it
 * opens. `App` renders it through one slot, at the top of the main column.
 * The drawer is a Radix dialog that portals under `<body>`, so only the top
 * bar takes a place in the layout: it sits around the workspace stack, not
 * inside it, so nothing about the split components' element tree changes
 * and a pane switch still remounts nothing.
 *
 * A phone moves between panes with the tab strip, and to another panel
 * through the palette (Next Pane, Focus Next Panel).
 */
export function PhoneChrome(props: PhoneChromeProps) {
  const { onShowAgents, onOpenProjectSettings, onAddProject, onOpenPalette } = props;

  const [drawerOpen, setDrawerOpen] = useState(false);

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
      />
      <KeyboardLift />
    </>
  );
}
