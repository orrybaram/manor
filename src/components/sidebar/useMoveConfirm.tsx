import { useState, type ReactNode } from "react";
import { useAppStore } from "../../store/app-store";
import { useProjectStore, type ProjectInfo } from "../../store/project-store";
import { LOCAL_HOST_ID } from "../../lib/hosts";
import { projectHasOpenPanes } from "../../lib/project-panes";
import type { TransferTarget } from "../../lib/transfer-targets";
import { ConfirmDialog } from "../ui/ConfirmDialog/ConfirmDialog";

/**
 * Move needs a confirmation when it would close tabs or strand workspaces
 * (ADR-213). The dialog must outlive the context menu (which unmounts on
 * select), so the owning row calls this hook, renders `dialog`, and passes
 * `requestMove` to the move `ProjectTransferMenu`.
 */
export function useMoveConfirm(project: ProjectInfo): {
  requestMove: (target: TransferTarget) => void;
  dialog: ReactNode;
} {
  const transferProject = useProjectStore((s) => s.transferProject);
  const workspaceLayouts = useAppStore((s) => s.workspaceLayouts);
  const [pending, setPending] = useState<TransferTarget | null>(null);
  const others = project.workspaces.filter((ws) => !ws.isMain).length;

  const requestMove = (target: TransferTarget) => {
    if (others > 0 || projectHasOpenPanes(project, workspaceLayouts)) {
      setPending(target);
    } else {
      void transferProject(project.id, target.hostId, "move");
    }
  };

  const oldHost =
    project.hostId === LOCAL_HOST_ID ? "this machine" : project.hostId;
  const dialog = (
    <ConfirmDialog
      open={pending !== null}
      title={`Move ${project.name} to ${pending?.label ?? ""}?`}
      description={
        others > 0
          ? `Moving closes this project's tabs. ${others} ${others === 1 ? "workspace stays" : "workspaces stay"} on ${oldHost} and won't show in Manor until you move back.`
          : "Moving closes this project's tabs."
      }
      confirmLabel="Move"
      onConfirm={() => {
        if (pending) void transferProject(project.id, pending.hostId, "move");
        setPending(null);
      }}
      onCancel={() => setPending(null)}
    />
  );
  return { requestMove, dialog };
}
