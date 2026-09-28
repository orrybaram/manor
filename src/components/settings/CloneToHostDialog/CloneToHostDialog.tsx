import { useCallback, useEffect, useId, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import X from "lucide-react/dist/esm/icons/x";
import { useProjectStore, type ProjectInfo } from "../../../store/project-store";
import { useHostStore } from "../../../store/host-store";
import { hostLabel } from "../../../lib/hosts";
import { toDirSlug } from "../../../utils/branch-name";
import { Button } from "../../ui/Button/Button";
import { Row, Stack } from "../../ui/Layout/Layout";
import { ToggleGroup } from "../../ui/ToggleGroup";
import { HostIndicator } from "../../hosts/HostIndicator";
import { useHostCloneFlow } from "../../hosts/useHostCloneFlow";
import { HostCloneSteps, RepoUrlAndRemoteDirFields } from "../../hosts/HostCloneSteps";
import styles from "../../hosts/HostCloneSteps.module.css";

type CloneToHostDialogProps = {
  open: boolean;
  project: ProjectInfo;
  /** The host to clone onto; with `hostIds`, the one chosen first. */
  hostId: string;
  /**
   * `move` (the default): `project` itself moves onto the host (ADR-179).
   * `addToGroup`: the clone is a new project, linked into `project`'s
   * group (ADR-192 ticket 4).
   */
  mode?: "move" | "addToGroup";
  /** Hosts the user may choose between; the host is fixed when omitted. */
  hostIds?: string[];
  onClose: () => void;
  /** Called with the resulting project once the clone succeeded. */
  onCloned?: (project: ProjectInfo) => void;
};

/**
 * Clone-onto-host flow for an EXISTING project (ADR-179), reusing the same
 * form → cloning → health steps as `AddProjectDialog`'s remote flow via
 * `useHostCloneFlow` (ADR-183 ticket 10). By default it updates the
 * project's own record with `moveProjectToHost` instead of creating a new
 * one; in `addToGroup` mode it adds a new member to the project's group
 * with `cloneIntoGroup` (ADR-192 ticket 4).
 */
export function CloneToHostDialog(props: CloneToHostDialogProps) {
  const { open, project, hostId: initialHostId, mode = "move", hostIds, onClose, onCloned } =
    props;

  const moveProjectToHost = useProjectStore((s) => s.moveProjectToHost);
  const cloneIntoGroup = useProjectStore((s) => s.cloneIntoGroup);
  const hosts = useHostStore((s) => s.hosts);
  const hostChoiceLabelId = useId();

  const [hostId, setHostId] = useState(initialHostId);
  const [repoUrl, setRepoUrl] = useState("");
  const [remoteDir, setRemoteDir] = useState("");
  const hostName = hostLabel(hostId, hosts);

  const flow = useHostCloneFlow({
    hostId,
    run: () => {
      const opts = { hostId, repoUrl: repoUrl.trim(), remoteDir: remoteDir.trim() };
      return mode === "addToGroup"
        ? cloneIntoGroup(project.id, opts)
        : moveProjectToHost(project.id, opts);
    },
  });

  // Pre-fill the repo URL from the project's current `origin` and a default
  // remote directory, every time the dialog opens for a (possibly different)
  // project/host.
  useEffect(() => {
    if (!open) return;
    flow.reset();
    setHostId(initialHostId);
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
  }, [open, project.id, initialHostId]);

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
    const cloned = await flow.start();
    if (cloned) onCloned?.(cloned);
  }, [repoUrl, remoteDir, flow, onCloned]);

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
            <Dialog.Title className={styles.title}>
              {mode === "addToGroup" ? "Clone onto another host" : "Clone onto host"}
            </Dialog.Title>
            <Dialog.Close asChild>
              <Button variant="ghost" size="sm" aria-label="Close">
                <X size={14} />
              </Button>
            </Dialog.Close>
          </Row>
          <Stack className={styles.body}>
            {flow.step === "form" && (
              <Stack gap="sm">
                {hostIds && hostIds.length > 1 ? (
                  <Stack>
                    <span className={styles.fieldLabel} id={hostChoiceLabelId}>
                      Host
                    </span>
                    <ToggleGroup
                      value={hostId}
                      onChange={setHostId}
                      size="sm"
                      aria-labelledby={hostChoiceLabelId}
                      data-testid="clone-to-host-host-choice"
                      options={hostIds.map((id) => ({
                        value: id,
                        label: <HostIndicator hostId={id} variant="label" />,
                      }))}
                    />
                  </Stack>
                ) : (
                  <Stack>
                    <label className={styles.fieldLabel}>Host</label>
                    <div className={styles.fieldStatic}>{hostName}</div>
                  </Stack>
                )}
                <RepoUrlAndRemoteDirFields
                  idPrefix="clone-to-host"
                  repoUrl={repoUrl}
                  onRepoUrlChange={setRepoUrl}
                  remoteDir={remoteDir}
                  onRemoteDirChange={setRemoteDir}
                />
                <div className={styles.fieldHint}>
                  {mode === "addToGroup" ? (
                    <>
                      The repo will be cloned on {hostName} — or an existing
                      clone there will be adopted — and linked to "{project.name}"
                      as another host. Manor doesn't copy your keys; log in on
                      the box first.
                    </>
                  ) : (
                    <>
                      The repo will be cloned on {hostName} — or an existing
                      clone there will be adopted — and "{project.name}" will
                      then run from it. Manor doesn't copy your keys; log in on
                      the box first.
                    </>
                  )}
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
