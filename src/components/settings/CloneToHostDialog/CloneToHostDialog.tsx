import { useCallback, useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import X from "lucide-react/dist/esm/icons/x";
import { useProjectStore, type ProjectInfo } from "../../../store/project-store";
import { useAppStore } from "../../../store/app-store";
import { useHostStore, selectHost } from "../../../store/host-store";
import type { HealthCheckResult } from "../../../lib/hosts";
import { ipcErrorMessage } from "../../../lib/ipc-error";
import { toDirSlug } from "../../../utils/branch-name";
import { Button } from "../../ui/Button/Button";
import { Input } from "../../ui/Input";
import { Row, Stack } from "../../ui/Layout/Layout";
import { CloneProgressLog } from "../../hosts/CloneProgressLog";
import { HealthCheckList } from "../../hosts/HealthCheckList";
import styles from "./CloneToHostDialog.module.css";

type CloneStep = "form" | "cloning" | "health";

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
 * form → cloning → health steps as `AddProjectDialog`'s remote flow, but
 * updating the project's own record via `moveProjectToHost` instead of
 * creating a new one.
 */
export function CloneToHostDialog(props: CloneToHostDialogProps) {
  const { open, project, hostId, onClose, onMoved } = props;

  const moveProjectToHost = useProjectStore((s) => s.moveProjectToHost);
  const host = useHostStore(selectHost(hostId));
  const hostLabel = host?.spec?.target ?? hostId;

  const [step, setStep] = useState<CloneStep>("form");
  const [repoUrl, setRepoUrl] = useState("");
  const [remoteDir, setRemoteDir] = useState("");
  const [progressLines, setProgressLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [movedProject, setMovedProject] = useState<ProjectInfo | null>(null);
  const [checks, setChecks] = useState<HealthCheckResult[] | null>(null);
  const [checksRunning, setChecksRunning] = useState(false);

  const reset = useCallback(() => {
    setStep("form");
    setRepoUrl("");
    setRemoteDir("");
    setProgressLines([]);
    setError(null);
    setMovedProject(null);
    setChecks(null);
    setChecksRunning(false);
  }, []);

  // Pre-fill the repo URL from the project's current `origin` and a default
  // remote directory, every time the dialog opens for a (possibly different)
  // project/host.
  useEffect(() => {
    if (!open) return;
    reset();
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
      if (!isOpen && step !== "cloning") {
        onClose();
      }
    },
    [onClose, step],
  );

  const runHealthChecks = useCallback(async (host: string, path: string) => {
    setChecksRunning(true);
    try {
      const results = await window.electronAPI.hosts.healthCheck(host, path);
      setChecks(results);
    } catch (err) {
      setError(ipcErrorMessage(err));
    } finally {
      setChecksRunning(false);
    }
  }, []);

  const handleClone = useCallback(async () => {
    if (!repoUrl.trim() || !remoteDir.trim()) return;
    setError(null);
    setProgressLines([]);
    setStep("cloning");

    const unsub = window.electronAPI.projects.onCloneProgress((event) => {
      if (event.status === "error") {
        setError(event.message ?? "Clone failed");
        return;
      }
      if (event.message) setProgressLines((lines) => [...lines, event.message!]);
    });

    try {
      const updated = await moveProjectToHost(project.id, {
        hostId,
        repoUrl: repoUrl.trim(),
        remoteDir: remoteDir.trim(),
      });
      unsub();
      setMovedProject(updated);
      setStep("health");
      onMoved?.();
      void runHealthChecks(hostId, updated.path);
    } catch (err) {
      unsub();
      setError(ipcErrorMessage(err));
      setStep("form");
    }
  }, [repoUrl, remoteDir, moveProjectToHost, project.id, hostId, onMoved, runHealthChecks]);

  const handleFixInTerminal = useCallback(
    (check: HealthCheckResult) => {
      if (!check.fixCommand || !movedProject) return;
      const ws =
        movedProject.workspaces.find((w) => w.isMain) ?? movedProject.workspaces[0];
      if (!ws) return;
      useAppStore.getState().setActiveWorkspace(ws.path);
      useAppStore.getState().addTerminalTabWithTypedText(check.fixCommand);
      // The terminal tab renders behind this dialog otherwise — close it so
      // the user lands where the command was typed.
      onClose();
    },
    [movedProject, onClose],
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
            {step === "form" && (
              <Stack gap="sm">
                <Stack>
                  <label className={styles.fieldLabel}>Host</label>
                  <div className={styles.fieldStatic}>{hostLabel}</div>
                </Stack>
                <Stack>
                  <label className={styles.fieldLabel} htmlFor="clone-to-host-repo-url">
                    Repo URL
                  </label>
                  <Input
                    id="clone-to-host-repo-url"
                    value={repoUrl}
                    onChange={(e) => setRepoUrl(e.target.value)}
                    placeholder="git@github.com:org/repo.git"
                  />
                </Stack>
                <Stack>
                  <label className={styles.fieldLabel} htmlFor="clone-to-host-remote-dir">
                    Remote directory
                  </label>
                  <Input
                    id="clone-to-host-remote-dir"
                    value={remoteDir}
                    onChange={(e) => setRemoteDir(e.target.value)}
                    placeholder="~/code/repo"
                  />
                </Stack>
                <div className={styles.fieldHint}>
                  The repo will be cloned on {hostLabel} — or an existing clone
                  there will be adopted — and "{project.name}" will then run
                  from it. Manor doesn't copy your keys; log in on the box
                  first.
                </div>
                {error && <div className={styles.error}>{error}</div>}
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

            {step === "cloning" && <CloneProgressLog lines={progressLines} />}

            {step === "health" && (
              <Stack gap="sm">
                <HealthCheckList
                  checks={checks}
                  running={checksRunning}
                  onRerun={() =>
                    movedProject && runHealthChecks(hostId, movedProject.path)
                  }
                  onFix={handleFixInTerminal}
                />
                <Row justify="flex-end">
                  <Button variant="primary" onClick={handleDone}>
                    Done
                  </Button>
                </Row>
              </Stack>
            )}
          </Stack>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
