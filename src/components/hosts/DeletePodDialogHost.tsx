import { useProjectStore } from "../../store/project-store";
import { useHostStore } from "../../store/host-store";
import { hostName } from "../../lib/hosts";
import { RemoveHostDialog } from "../settings/HostsPage/RemoveHostDialog";

/**
 * The app-wide mount for "Delete the pod" on a failed "In a new pod":
 * the same typed confirm as Settings → Hosts → Remove, opened
 * by the store's `deletePodDialog`.
 */
export function DeletePodDialogHost() {
  const dialog = useProjectStore((s) => s.deletePodDialog);
  const close = useProjectStore((s) => s.closeDeletePod);
  const host = useHostStore((s) => s.hosts.find((h) => h.hostId === dialog?.hostId));

  if (!dialog || !host) return null;

  return (
    <RemoveHostDialog
      open
      hostId={host.hostId}
      hostName={hostName(host)}
      canDestroy={host.capabilities?.canDestroy === true}
      onRemove={(destroy) => useHostStore.getState().removeHost(host.hostId, destroy)}
      onClose={close}
    />
  );
}
