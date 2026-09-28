import { useCallback, useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import X from "lucide-react/dist/esm/icons/x";
import { useProjectStore, type ProjectInfo } from "../../../store/project-store";
import { useHostStore } from "../../../store/host-store";
import { hostLabel } from "../../../lib/hosts";
import { toDirSlug } from "../../../utils/branch-name";
import { Button } from "../../ui/Button/Button";
import { Row, Stack } from "../../ui/Layout/Layout";
import { useHostCloneFlow } from "../../hosts/useHostCloneFlow";
import { HostCloneSteps, RepoUrlAndRemoteDirFields } from "../../hosts/HostCloneSteps";
import styles from "../../hosts/HostCloneSteps.module.css";

type CloneToHostDialogProps = {
  open: boolean;
  project: ProjectInfo;
  hostId: string;
  onClose: () => void;
  /** Called once the project's record has been moved onto the host. */
  onMoved?: () => void;
};

/**
 * Clone-onto-host flow for an EXISTING project (ADR-179), reusing the same
 * form → cloning → health steps as `AddProjectDialog`'s remote flow via
 * `useHostCloneFlow` (ADR-183 ticket 10), but updating the project's own
 * record with `moveProjectToHost` instead of creating a new one.
 */
export function CloneToHostDialog(props: CloneToHostDialogProps) {
  const { open, project, hostId, onClose, onMoved } = props;

  const moveProjectToHost = useProjectStore((s) => s.moveProjectToHost);
  const hosts = useHostStore((s) => s.hosts);
  const hostName = hostLabel(hostId, hosts);

  const [repoUrl, setRepoUrl] = useState("");
  const [remoteDir, setRemoteDir] = useState("");

  const flow = useHostCloneFlow({
    hostId,
    run: () =>
      moveProjectToHost(project.id, {
        hostId,
        repoUrl: repoUrl.trim(),
        remoteDir: remoteDir.trim(),
      }),
  });

  // Pre-fill the repo URL from the project's current `origin` and a default
  // remote directory, every time the dialog opens for a (possibly different)
  // project/host.
  useEffect(() => {
    if (!open) return;
    flow.reset();
    setRepoUrl("");
    setRemoteDir(`~/code/${toDirSlug(project.name)}`);
    window.electronAPI.projects
      .getOriginUrl(project.id)
      .then((url) => {
        if (url) setRepoUrl(url);
      })
      .catch(() => {
        /* leave the field blank — the user can type it in */
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, project.id, hostId]);

  const handleOpenChange = useCallback(
    (isOpen: boolean) => {
      if (!isOpen && flow.step !== "cloning") {
        onClose();
      }
    },
    [onClose, flow.step],
  );

  const handleClone = useCallback(async () => {
    if (!repoUrl.trim() || !remoteDir.trim()) return;
    const moved = await flow.start();
    if (moved) onMoved?.();
  }, [repoUrl, remoteDir, flow, onMoved]);

  const handleFixInTerminal = useCallback(
    (check: Parameters<typeof flow.fix>[0]) => {
      flow.fix(check);
      // The terminal tab renders behind this dialog otherwise — close it so
      // the user lands where the command was typed.
      onClose();
    },
    [flow, onClose],
  );

  const handleDone = useCallback(() => {
    onClose();
  }, [onClose]);

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content className={styles.dialog} data-testid="clone-to-host-dialog">
          <Row align="center" justify="space-between" className={styles.header}>
            <Dialog.Title className={styles.title}>Clone onto host</Dialog.Title>
            <Dialog.Close asChild>
              <Button variant="ghost" size="sm" aria-label="Close">
                <X size={14} />
              </Button>
            </Dialog.Close>
          </Row>
          <Stack className={styles.body}>
            {flow.step === "form" && (
              <Stack gap="sm">
                <Stack>
                  <label className={styles.fieldLabel}>Host</label>
                  <div className={styles.fieldStatic}>{hostName}</div>
                </Stack>
                <RepoUrlAndRemoteDirFields
                  idPrefix="clone-to-host"
                  repoUrl={repoUrl}
                  onRepoUrlChange={setRepoUrl}
                  remoteDir={remoteDir}
                  onRemoteDirChange={setRemoteDir}
                />
                <div className={styles.fieldHint}>
                  The repo will be cloned on {hostName} — or an existing clone
                  there will be adopted — and "{project.name}" will then run
                  from it. Manor doesn't copy your keys; log in on the box
                  first.
                </div>
                {flow.error && <div className={styles.error}>{flow.error}</div>}
                <Row gap="sm" justify="flex-end">
                  <Button variant="secondary" onClick={onClose}>
                    Cancel
                  </Button>
                  <Button
                    variant="primary"
                    disabled={!repoUrl.trim() || !remoteDir.trim()}
                    onClick={handleClone}
                  >
                    Clone
                  </Button>
                </Row>
              </Stack>
            )}

            {(flow.step === "cloning" || flow.step === "health") && (
              <HostCloneSteps
                step={flow.step}
                progressLines={flow.progressLines}
                checks={flow.checks}
                checksRunning={flow.checksRunning}
                onRerun={flow.rerun}
                onFix={handleFixInTerminal}
                onDone={handleDone}
              />
            )}
          </Stack>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
