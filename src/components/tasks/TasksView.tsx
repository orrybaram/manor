import type { PaletteView } from "../command-palette/types";

interface TasksViewProps {
  onNewWorkspace: (opts?: { projectId?: string; name?: string }) => void;
  onOpenPaletteView: (view: PaletteView) => void;
}

/** Placeholder for the Tasks surface (ADR-197); the full view lands in ticket 3. */
export function TasksView(_props: TasksViewProps) {
  return (
    <div>
      <h1>Tasks</h1>
    </div>
  );
}
