import { useCallback, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import X from "lucide-react/dist/esm/icons/x";
import Loader2 from "lucide-react/dist/esm/icons/loader-2";
import CheckCircle2 from "lucide-react/dist/esm/icons/check-circle-2";
import XCircle from "lucide-react/dist/esm/icons/x-circle";
import { useProjectStore } from "../../../store/project-store";
import { useAppStore } from "../../../store/app-store";
import { useHostStore } from "../../../store/host-store";
import { LOCAL_HOST_ID, type HealthCheckResult } from "../../../lib/hosts";
import { Button } from "../../ui/Button/Button";
import { Input } from "../../ui/Input";
import { SearchableSelect } from "../../ui/SearchableSelect";
import { ToggleGroup } from "../../ui/ToggleGroup";
import { Row, Stack } from "../../ui/Layout/Layout";
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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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
    setAddingLocal(true);
    try {
      await onAddLocal();
      onClose();
      reset();
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
      setRemoteError(errorMessage(err));
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

    const unsub = window.electronAPI.projects.onWorktreeSetupProgress(
      (event) => {
        const e = event as { step?: string; status?: string; message?: string };
        if (e.step !== "clone") return;
        if (e.status === "error") {
          setRemoteError(e.message ?? "Clone failed");
          return;
        }
        if (e.message) setProgressLines((lines) => [...lines, e.message!]);
      },
    );

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
      setRemoteError(errorMessage(err));
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
    },
    [projectId, projectPath],
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
              <Button variant="ghost" size="sm">
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
                      <label className={styles.fieldLabel}>Host</label>
                      <SearchableSelect
                        value={hostId}
                        onChange={setHostId}
                        options={remoteHostOptions}
                        emptyMessage="Add a host in Project Settings → Host first"
                        placeholder="Select a host…"
                      />
                    </Stack>
                    <Stack>
                      <label className={styles.fieldLabel}>Repo URL</label>
                      <Input
                        value={repoUrl}
                        onChange={(e) => {
                          setRepoUrl(e.target.value);
                          if (!nameEdited) setName(nameFromRepoUrl(e.target.value));
                        }}
                        placeholder="git@github.com:org/repo.git"
                      />
                    </Stack>
                    <Stack>
                      <label className={styles.fieldLabel}>Remote directory</label>
                      <Input
                        value={remoteDir}
                        onChange={(e) => setRemoteDir(e.target.value)}
                        placeholder="~/code/repo"
                      />
                    </Stack>
                    <Stack>
                      <label className={styles.fieldLabel}>Name</label>
                      <Input
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

            {remoteStep === "cloning" && (
              <Stack gap="sm">
                <Row gap="xs" align="center">
                  <Loader2 size={14} className={styles.spinner} />
                  <span>Cloning…</span>
                </Row>
                <div className={styles.progressLog} data-testid="clone-progress-log">
                  {progressLines.slice(-8).map((line, i) => (
                    <div key={i} className={styles.progressLine}>
                      {line}
                    </div>
                  ))}
                </div>
              </Stack>
            )}

            {remoteStep === "health" && (
              <Stack gap="sm">
                <Row align="center" justify="space-between">
                  <span className={styles.fieldLabel}>Host health check</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={checksRunning || !projectPath}
                    onClick={() => hostId && projectPath && runHealthChecks(hostId, projectPath)}
                  >
                    {checksRunning ? "Checking…" : "Re-run checks"}
                  </Button>
                </Row>
                <Stack gap="xs" data-testid="health-check-list">
                  {(checks ?? []).map((check) => (
                    <Row key={check.id} align="center" justify="space-between" gap="sm">
                      <Row align="center" gap="xs">
                        {check.ok ? (
                          <CheckCircle2 size={14} className={styles.ok} />
                        ) : (
                          <XCircle size={14} className={styles.fail} />
                        )}
                        <Stack gap="2xs">
                          <span>{check.label}</span>
                          <span className={styles.fieldHint}>{check.detail}</span>
                        </Stack>
                      </Row>
                      {!check.ok && check.fixCommand && (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => handleFixInTerminal(check)}
                        >
                          Fix in terminal
                        </Button>
                      )}
                    </Row>
                  ))}
                </Stack>
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
