import { useProjectStore } from "../../store/project-store";
import { useHostStore } from "../../store/host-store";
import { transferTargets } from "../../lib/transfer-targets";
import { CloneToHostDialog } from "./CloneToHostDialog";

const openingKeys = new WeakMap<object, number>();
let nextOpeningKey = 0;
/** A stable key per opening: each `openTransferDialog` call stores a new object. */
function openingKey(dialog: object): number {
  let key = openingKeys.get(dialog);
  if (key === undefined) {
    key = nextOpeningKey++;
    openingKeys.set(dialog, key);
  }
  return key;
}

/**
 * The app-wide mount for ADR-213's fallback dialog, driven by the store's
 * `transferDialog`. Each opening gets a new `key` because `CloneToHostDialog`
 * starts its state fresh on mount.
 */
export function TransferDialogHost() {
  const dialog = useProjectStore((s) => s.transferDialog);
  const closeTransferDialog = useProjectStore((s) => s.closeTransferDialog);
  const projects = useProjectStore((s) => s.projects);
  const hosts = useHostStore((s) => s.hosts);

  const project = dialog && projects.find((p) => p.id === dialog.projectId);
  if (!dialog || !project) return null;

  return (
    <CloneToHostDialog
      key={openingKey(dialog)}
      open
      mode={dialog.mode}
      project={project}
      hostChoices={transferTargets(project, projects, hosts, dialog.mode)}
      initialHostId={dialog.hostId}
      initialRepoUrl={dialog.repoUrl}
      initialDir={dialog.targetDir}
      reason={dialog.reason}
      error={dialog.error}
      onClose={closeTransferDialog}
    />
  );
}
