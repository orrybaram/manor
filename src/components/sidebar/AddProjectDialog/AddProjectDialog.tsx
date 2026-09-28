import { useCallback, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import X from "lucide-react/dist/esm/icons/x";
import { useProjectStore, type ProjectInfo } from "../../../store/project-store";
import { useHostStore } from "../../../store/host-store";
import { addErrorToast } from "../../../store/toast-store";
import { remoteHostOptions } from "../../../lib/hosts";
import { Button } from "../../ui/Button/Button";
import { Input } from "../../ui/Input";
import { SearchableSelect } from "../../ui/SearchableSelect";
import { ToggleGroup } from "../../ui/ToggleGroup";
import { Row, Stack } from "../../ui/Layout/Layout";
import { useHostCloneFlow } from "../../hosts/useHostCloneFlow";
import { HostCloneSteps, RepoUrlAndRemoteDirFields } from "../../hosts/HostCloneSteps";
import styles from "../../hosts/HostCloneSteps.module.css";

type Mode = "local" | "remote";

type AddProjectDialogProps = {
  open: boolean;
  onClose: () => void;
  /** "This Mac" picks a directory and adds it; mirrors the old flow. */
  onAddLocal: () => Promise<void>;
  /** Called once the remote clone finishes and the project is added. */
  onRemoteProjectAdded?: (project: ProjectInfo) => void;
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
 * post-clone health check (ADR-178 ticket 5). The remote flow's form →
 * cloning → health state machine is shared with `CloneToHostDialog` via
 * `useHostCloneFlow` (ADR-183 ticket 10).
 */
export function AddProjectDialog(props: AddProjectDialogProps) {
  const { open, onClose, onAddLocal, onRemoteProjectAdded } = props;

  const [mode, setMode] = useState<Mode>("local");
  const [addingLocal, setAddingLocal] = useState(false);

  const hosts = useHostStore((s) => s.hosts);
  const addRemoteProject = useProjectStore((s) => s.addRemoteProject);

  const options = useMemo(() => remoteHostOptions(hosts), [hosts]);

  const [hostId, setHostId] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [remoteDir, setRemoteDir] = useState("");
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);

  const flow = useHostCloneFlow({
    hostId,
    run: () =>
      addRemoteProject({
        hostId,
        repoUrl: repoUrl.trim(),
        remoteDir: remoteDir.trim(),
        name: name.trim() || nameFromRepoUrl(repoUrl),
      }),
  });

  const reset = useCallback(() => {
    setMode("local");
    setHostId("");
    setRepoUrl("");
    setRemoteDir("");
    setName("");
    setNameEdited(false);
    flow.reset();
  }, [flow]);

  const handleOpenChange = useCallback(
    (isOpen: boolean) => {
      if (!isOpen && flow.step !== "cloning") {
        onClose();
        reset();
      }
    },
    [onClose, reset, flow.step],
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

  const handleClone = useCallback(async () => {
    if (!hostId || !repoUrl.trim() || !remoteDir.trim()) return;
    const project = await flow.start();
    if (project) onRemoteProjectAdded?.(project);
  }, [hostId, repoUrl, remoteDir, flow, onRemoteProjectAdded]);

  const handleFixInTerminal = useCallback(
    (check: Parameters<typeof flow.fix>[0]) => {
      flow.fix(check);
      // The terminal tab renders behind this dialog otherwise (ADR-178
      // ticket 5 review) — close it so the user lands where the command was
      // typed.
      onClose();
      reset();
    },
    [flow, onClose, reset],
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
            {flow.step === "form" && (
              <>
                <ToggleGroup
                  value={mode}
                  onChange={setMode}
                  size="sm"
                  aria-label="Where the project lives"
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
                        options={options}
                        emptyMessage="Add a host in Project Settings → Host first"
                        placeholder="Select a host…"
                      />
                    </Stack>
                    <RepoUrlAndRemoteDirFields
                      idPrefix="add-project"
                      repoUrl={repoUrl}
                      onRepoUrlChange={(value) => {
                        setRepoUrl(value);
                        if (!nameEdited) setName(nameFromRepoUrl(value));
                      }}
                      remoteDir={remoteDir}
                      onRemoteDirChange={setRemoteDir}
                    />
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
                    {flow.error && <div className={styles.error}>{flow.error}</div>}
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
