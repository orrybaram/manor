import { useState } from "react";
import { Checkbox } from "../ui/Checkbox/Checkbox";
import { deletePodsLabel, finishPods, podsOf } from "../../lib/project-pods";
import styles from "./dialogs.module.css";
import { useHostStore } from "../../store/host-store";
import { useProjectStore } from "../../store/project-store";
import { memberHostName } from "../../lib/hosts";
import { serverHostName } from "../../bridge/server-set";
import { ConfirmDialog } from "../ui/ConfirmDialog/ConfirmDialog";

/**
 * Confirms removing a project from one host (ADR-214). Mounted once in
 * `App`, driven by the store's `removeFromHostDialog`, so the set-up
 * success toast can open it too.
 */
export function RemoveFromHostDialog() {
  const request = useProjectStore((s) => s.removeFromHostDialog);
  const close = useProjectStore((s) => s.closeRemoveFromHost);
  const removeFromHost = useProjectStore((s) => s.removeFromHost);
  const member = useProjectStore((s) =>
    s.removeFromHostDialog
      ? s.projects.find((p) => p.id === s.removeFromHostDialog?.projectId)
      : undefined,
  );
  const hosts = useHostStore((s) => s.hosts);
  const [deletePod, setDeletePod] = useState(true);

  // On a phone the page is not "This machine" (ADR-228 D8).
  const host = member
    ? (serverHostName(member.hostId) ?? memberHostName(member.hostId, hosts))
    : "";
  const others = member ? member.workspaces.filter((ws) => !ws.isMain).length : 0;
  const description = member
    ? `Files there aren't deleted.${
        others > 0
          ? ` Its ${others} ${others === 1 ? "workspace" : "workspaces"} on ${host} won't show in Manor.`
          : ""
      }`
    : "";

  const pods = member ? podsOf([member], hosts) : [];

  return (
    <ConfirmDialog
      open={request !== null && member !== undefined}
      title={`Remove ${member?.name ?? ""} from ${host}?`}
      description={
        <>
          {description}
          {pods.length > 0 && (
            <>
              <label className={styles.podOption}>
                <Checkbox
                  checked={deletePod}
                  onCheckedChange={(checked) => setDeletePod(checked === true)}
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
      onConfirm={() => {
        if (member) {
          void removeFromHost(member.id).then((removed) => {
            if (removed && pods.length > 0) return finishPods(pods, deletePod);
          });
        }
        close();
      }}
      onCancel={close}
    />
  );
}
