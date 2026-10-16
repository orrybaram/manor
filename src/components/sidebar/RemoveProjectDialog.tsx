import { useState } from "react";
import { ConfirmDialog } from "../ui/ConfirmDialog/ConfirmDialog";
import { Checkbox } from "../ui/Checkbox/Checkbox";
import { useHostStore } from "../../store/host-store";
import { deletePodsLabel, finishPods, podsOf } from "../../lib/project-pods";
import styles from "./dialogs.module.css";

type RemoveProjectDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectName: string;
  /**
   * The projects being removed (a group's members), so the dialog can offer
   * to delete the pods made for them (ADR-235 D6).
   */
  members?: ReadonlyArray<{ id: string; hostId: string }>;
  /** Awaited: the dialog closes once it resolves and stays open if it rejects. */
  onConfirm: () => Promise<void>;
};

export function RemoveProjectDialog(props: RemoveProjectDialogProps) {
  const { open, onOpenChange, projectName, members = [], onConfirm } = props;
  const hosts = useHostStore((s) => s.hosts);
  const pods = podsOf(members, hosts);
  const [deletePods, setDeletePods] = useState(true);

  return (
    <ConfirmDialog
      open={open}
      title="Remove Project"
      description={
        <>
          Remove <strong>{projectName}</strong> from the sidebar? This won't
          delete any files on disk.
          {pods.length > 0 && (
            <>
              <label className={styles.podOption}>
                <Checkbox
                  checked={deletePods}
                  onCheckedChange={(checked) => setDeletePods(checked === true)}
                />
                <span>{deletePodsLabel(pods)}</span>
              </label>
              <span className={styles.podOptionHint}>There is no undo.</span>
            </>
          )}
        </>
      }
      confirmLabel="Remove"
      confirmVariant="danger"
      onConfirm={async () => {
        await onConfirm();
        onOpenChange(false);
        if (pods.length > 0) void finishPods(pods, deletePods);
      }}
      onCancel={() => onOpenChange(false)}
    />
  );
}
