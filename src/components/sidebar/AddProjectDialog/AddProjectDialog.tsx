import { useCallback, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import X from "lucide-react/dist/esm/icons/x";
import { useProjectStore } from "../../../store/project-store";
import { useAppStore } from "../../../store/app-store";
import { useHostStore } from "../../../store/host-store";
import { addErrorToast } from "../../../store/toast-store";
import { LOCAL_HOST_ID, type HealthCheckResult } from "../../../lib/hosts";
import { ipcErrorMessage } from "../../../lib/ipc-error";
import { Button } from "../../ui/Button/Button";
import { Input } from "../../ui/Input";
import { SearchableSelect } from "../../ui/SearchableSelect";
import { ToggleGroup } from "../../ui/ToggleGroup";
import { Row, Stack } from "../../ui/Layout/Layout";
import { CloneProgressLog } from "../../hosts/CloneProgressLog";
import { HealthCheckList } from "../../hosts/HealthCheckList";
import styles from "./AddProjectDialog.module.css";

type Mode = "local" | "remote";
type RemoteStep = "form" | "cloning" | "health";

type AddProjectDialogProps = {
  open: boolean;
  onClose: () => void;
  /** "This Mac" picks a directory and adds it; mirrors the old flow. */
  onAddLocal: () => Promise<void>;
  /** Called once the remote clone finishes and the project is added. */
  onRemoteProjectAdded?: () => void;
};

/** Derive a project name from a repo URL's last path segment. */
function nameFromRepoUrl(repoUrl: string): string {
  const trimmed = repoUrl.trim().replace(/\.git$/, "");
  const last = trimmed.split(/[/:]/).pop() ?? "";
  return last || "project";
}

/**
 * "Add Project" now offers a choice: a local directory (the pre-ADR-178
 * flow) or a repo cloned onto a remote host, with clone progress and a
 * post-clone health check (ADR-178 ticket 5).
 */
export function AddProjectDialog(props: AddProjectDialogProps) {
  const { open, onClose, onAddLocal, onRemoteProjectAdded } = props;

  const [mode, setMode] = useState<Mode>("local");
  const [addingLocal, setAddingLocal] = useState(false);

  const hosts = useHostStore((s) => s.hosts);
  const addRemoteProject = useProjectStore((s) => s.addRemoteProject);

  const remoteHostOptions = useMemo(
    () =>
      hosts
        .filter((h) => h.hostId !== LOCAL_HOST_ID)
        .map((h) => ({ value: h.hostId, label: h.spec?.target ?? h.hostId })),
    [hosts],
  );

  const [hostId, setHostId] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [remoteDir, setRemoteDir] = useState("");
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [remoteStep, setRemoteStep] = useState<RemoteStep>("form");
  const [progressLines, setProgressLines] = useState<string[]>([]);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [checks, setChecks] = useState<HealthCheckResult[] | null>(null);
  const [checksRunning, setChecksRunning] = useState(false);

  const reset = useCallback(() => {
    setMode("local");
    setHostId("");
    setRepoUrl("");
    setRemoteDir("");
    setName("");
    setNameEdited(false);
    setRemoteStep("form");
    setProgressLines([]);
    setRemoteError(null);
    setProjectId(null);
    setProjectPath(null);
    setChecks(null);
    setChecksRunning(false);
  }, []);

  const handleOpenChange = useCallback(
    (isOpen: boolean) => {
      if (!isOpen && remoteStep !== "cloning") {
        onClose();
        reset();
      }
    },
    [onClose, reset, remoteStep],
  );

  const handleAddLocal = useCallback(async () => {
    // The local flow opens a folder picker and then `ProjectSetupWizard` —
    // both would otherwise render underneath this Radix dialog while it
    // waits for `onAddLocal` to resolve. Close it first so the picker and
    // wizard are on top (ADR-178 ticket 5 review); an error surfaces as a
    // toast instead of inline, since the dialog is already gone.
    onClose();
    reset();
    setAddingLocal(true);
    try {
      await onAddLocal();
    } catch (err) {
      addErrorToast("add-local-project", "Failed to add project", err);
    } finally {
      setAddingLocal(false);
    }
  }, [onAddLocal, onClose, reset]);

  const runHealthChecks = useCallback(async (host: string, path: string) => {
    setChecksRunning(true);
    try {
      const results = await window.electronAPI.hosts.healthCheck(host, path);
      setChecks(results);
    } catch (err) {
      setRemoteError(ipcErrorMessage(err));
    } finally {
      setChecksRunning(false);
    }
  }, []);

  const handleClone = useCallback(async () => {
    if (!hostId || !repoUrl.trim() || !remoteDir.trim()) return;
    const projectName = name.trim() || nameFromRepoUrl(repoUrl);
    setRemoteError(null);
    setProgressLines([]);
    setRemoteStep("cloning");

    const unsub = window.electronAPI.projects.onCloneProgress((event) => {
      if (event.status === "error") {
        setRemoteError(event.message ?? "Clone failed");
        return;
      }
      if (event.message) setProgressLines((lines) => [...lines, event.message!]);
    });

    try {
      const project = await addRemoteProject({
        hostId,
        repoUrl: repoUrl.trim(),
        remoteDir: remoteDir.trim(),
        name: projectName,
      });
      unsub();
      setProjectId(project.id);
      setProjectPath(project.path);
      setRemoteStep("health");
      onRemoteProjectAdded?.();
      void runHealthChecks(hostId, project.path);
    } catch (err) {
      unsub();
      setRemoteError(ipcErrorMessage(err));
      setRemoteStep("form");
    }
  }, [
    hostId,
    repoUrl,
    remoteDir,
    name,
    addRemoteProject,
    runHealthChecks,
    onRemoteProjectAdded,
  ]);

  const handleFixInTerminal = useCallback(
    (check: HealthCheckResult) => {
      if (!check.fixCommand || !projectId || !projectPath) return;
      const project = useProjectStore
        .getState()
        .projects.find((p) => p.id === projectId);
      const ws = project?.workspaces.find((w) => w.isMain) ?? project?.workspaces[0];
      if (!ws) return;
      useAppStore.getState().setActiveWorkspace(ws.path);
      useAppStore.getState().addTerminalTabWithTypedText(check.fixCommand);
      // The terminal tab renders behind this dialog otherwise (ADR-178
      // ticket 5 review) — close it so the user lands where the command was
      // typed.
      onClose();
      reset();
    },
    [projectId, projectPath, onClose, reset],
  );

  const handleDone = useCallback(() => {
    onClose();
    reset();
  }, [onClose, reset]);

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content className={styles.dialog} data-testid="add-project-dialog">
          <Row align="center" justify="space-between" className={styles.header}>
            <Dialog.Title className={styles.title}>Add Project</Dialog.Title>
            <Dialog.Close asChild>
              <Button variant="ghost" size="sm" aria-label="Close">
                <X size={14} />
              </Button>
            </Dialog.Close>
          </Row>
          <Stack className={styles.body}>
            {remoteStep === "form" && (
              <>
                <ToggleGroup
                  value={mode}
                  onChange={setMode}
                  size="sm"
                  options={[
                    { value: "local", label: "On this Mac" },
                    { value: "remote", label: "On a remote host" },
                  ]}
                />
                {mode === "local" ? (
                  <Stack gap="sm">
                    <div className={styles.fieldHint}>
                      Choose a folder on this machine.
                    </div>
                    <Row justify="flex-end">
                      <Button
                        variant="primary"
                        disabled={addingLocal}
                        onClick={handleAddLocal}
                      >
                        {addingLocal ? "Adding…" : "Choose Folder…"}
                      </Button>
                    </Row>
                  </Stack>
                ) : (
                  <Stack gap="sm">
                    <Stack>
                      <label className={styles.fieldLabel} htmlFor="add-project-host">
                        Host
                      </label>
                      <SearchableSelect
                        id="add-project-host"
                        value={hostId}
                        onChange={setHostId}
                        options={remoteHostOptions}
                        emptyMessage="Add a host in Project Settings → Host first"
                        placeholder="Select a host…"
                      />
                    </Stack>
                    <Stack>
                      <label className={styles.fieldLabel} htmlFor="add-project-repo-url">
                        Repo URL
                      </label>
                      <Input
                        id="add-project-repo-url"
                        value={repoUrl}
                        onChange={(e) => {
                          setRepoUrl(e.target.value);
                          if (!nameEdited) setName(nameFromRepoUrl(e.target.value));
                        }}
                        placeholder="git@github.com:org/repo.git"
                      />
                    </Stack>
                    <Stack>
                      <label className={styles.fieldLabel} htmlFor="add-project-remote-dir">
                        Remote directory
                      </label>
                      <Input
                        id="add-project-remote-dir"
                        value={remoteDir}
                        onChange={(e) => setRemoteDir(e.target.value)}
                        placeholder="~/code/repo"
                      />
                    </Stack>
                    <Stack>
                      <label className={styles.fieldLabel} htmlFor="add-project-name">
                        Name
                      </label>
                      <Input
                        id="add-project-name"
                        value={name}
                        onChange={(e) => {
                          setName(e.target.value);
                          setNameEdited(true);
                        }}
                        placeholder={nameFromRepoUrl(repoUrl) || "Project name"}
                      />
                    </Stack>
                    <div className={styles.fieldHint}>
                      Log in on the box — Manor doesn't copy your keys.
                    </div>
                    {remoteError && <div className={styles.error}>{remoteError}</div>}
                    <Row gap="sm" justify="flex-end">
                      <Button variant="secondary" onClick={onClose}>
                        Cancel
                      </Button>
                      <Button
                        variant="primary"
                        disabled={!hostId || !repoUrl.trim() || !remoteDir.trim()}
                        onClick={handleClone}
                      >
                        Clone
                      </Button>
                    </Row>
                  </Stack>
                )}
              </>
            )}

            {remoteStep === "cloning" && <CloneProgressLog lines={progressLines} />}

            {remoteStep === "health" && (
              <Stack gap="sm">
                <HealthCheckList
                  checks={checks}
                  running={checksRunning}
                  onRerun={() => hostId && projectPath && runHealthChecks(hostId, projectPath)}
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
