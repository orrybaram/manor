import { useHostStore } from "../../store/host-store";
import { useProjectStore } from "../../store/project-store";
import { memberHostName } from "../../lib/hosts";
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

  const host = member ? memberHostName(member.hostId, hosts) : "";
  const others = member ? member.workspaces.filter((ws) => !ws.isMain).length : 0;
  const description = member
    ? `Files there aren't deleted.${
        others > 0
          ? ` Its ${others} ${others === 1 ? "workspace" : "workspaces"} on ${host} won't show in Manor.`
          : ""
      }`
    : "";

  return (
    <ConfirmDialog
      open={request !== null && member !== undefined}
      title={`Remove ${member?.name ?? ""} from ${host}?`}
      description={description}
      confirmLabel="Remove"
      confirmVariant="danger"
      onConfirm={() => {
        if (member) void removeFromHost(member.id);
        close();
      }}
      onCancel={close}
    />
  );
}
