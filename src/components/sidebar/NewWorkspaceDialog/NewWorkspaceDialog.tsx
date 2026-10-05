import { useState, useRef, useCallback, useMemo } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import X from "lucide-react/dist/esm/icons/x";
import Loader2 from "lucide-react/dist/esm/icons/loader-2";
import GitBranch from "lucide-react/dist/esm/icons/git-branch";
import Box from "lucide-react/dist/esm/icons/box";
import Folder from "lucide-react/dist/esm/icons/folder";
import { useQuery } from "@tanstack/react-query";
import {
  useProjectStore,
  type ProjectInfo,
} from "../../../store/project-store";
import { Input } from "../../ui/Input";
import { EmojiInput } from "../../ui/EmojiAutocomplete";
import { Button } from "../../ui/Button/Button";
import { SearchableSelect } from "../../ui/SearchableSelect";
import { ToggleGroup } from "../../ui/ToggleGroup";
import styles from "./NewWorkspaceDialog.module.css";
import { Row, Stack } from "../../ui/Layout/Layout";
import { sanitizeBranchName } from "../../../utils/branch-name";
import { useRestoreFocus } from "../../../hooks/useRestoreFocus";
import { useHostStore } from "../../../store/host-store";
import { hostLabel } from "../../../lib/hosts";
import {
  hostsToCloneOnto,
  memberAfterClone,
  startingMemberId,
  workspaceHostChoices,
} from "../../../lib/workspace-host-choices";
import {
  baseBranchOptions,
  checkBranchOnHost,
  existingBranchOptions as listExistingBranchOptions,
  projectForSelectValue,
  projectSelectOptions,
  projectSelectValue,
  reseedBaseBranch,
} from "../../../lib/new-workspace";
import { HostPicker } from "./HostPicker";
import { CloneToHostDialog } from "../../hosts/CloneToHostDialog";

type Mode = "new" | "existing";

const NO_BRANCHES: string[] = [];

type NewWorkspaceDialogProps = {
  open: boolean;
  onClose: () => void;
  onSubmit: (
    projectId: string,
    name: string,
    branchName: string,
    baseBranch: string,
    useExistingBranch?: boolean,
    /** Sidebar folder to file the new workspace under; null for none. */
    folderId?: string | null,
  ) => Promise<boolean>;
  projects: ProjectInfo[];
  selectedProjectIndex: number;
  preselectedProjectId?: string | null;
  initialName?: string;
  initialBranch?: string;
  /** Folder preselected when the dialog opens from a folder's own menu. */
  initialFolderId?: string | null;
  /**
   * For a linked project (ADR-192): the member the host picker starts on
   * ahead of the group's last-used host, because the dialog was opened from
   * that member's own section or folder.
   */
  preferredMemberId?: string | null;
};

export function NewWorkspaceDialog(props: NewWorkspaceDialogProps) {
  const {
    open,
    onClose,
    onSubmit,
    projects,
    selectedProjectIndex,
    preselectedProjectId,
    initialName = "",
    initialBranch = "",
    initialFolderId = null,
    preferredMemberId = null,
  } = props;

  const { onCloseAutoFocus: restoreFocusOnClose } = useRestoreFocus(open);

  const [mode, setMode] = useState<Mode>("new");
  const [name, setName] = useState("");
  const [branchName, setBranchName] = useState("");
  const [branchManuallyEdited, setBranchManuallyEdited] = useState(false);
  const [baseBranch, setBaseBranch] = useState("");
  const [baseBranchEdited, setBaseBranchEdited] = useState(false);
  const [existingBranch, setExistingBranch] = useState("");
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [folderId, setFolderId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  /**
   * "Clone onto another host…": the member it was opened from, pinned so
   * the clone keeps its source while the new member joins and becomes the
   * selection. `key` gives each opening a fresh dialog, and `open` false
   * keeps the closed one mounted while its exit animation plays.
   */
  const [cloneSession, setCloneSession] = useState<{
    key: number;
    projectId: string;
    open: boolean;
  } | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const handleOpenChange = useCallback(
    (isOpen: boolean) => {
      if (!isOpen && !isCreating) onClose();
    },
    [onClose, isCreating],
  );

  const hosts = useHostStore((s) => s.hosts);

  // A linked project creates in one member: the one the host picker starts
  // on (ADR-192). Anything else is created in as it is.
  const defaultProjectId = startingMemberId(
    preselectedProjectId || projects[selectedProjectIndex]?.id || "",
    projects,
    hosts,
    preferredMemberId,
  );

  const activeProjectId = selectedProjectId || defaultProjectId;

  const activeProject = projects.find((p) => p.id === activeProjectId);
  const defaultBranch = activeProject?.defaultBranch ?? "main";
  const hostChoices = useMemo(
    () => workspaceHostChoices(activeProject, projects, hosts),
    [activeProject, projects, hosts],
  );
  const activeHostChoice = hostChoices?.find((c) => c.projectId === activeProjectId);
  const cloneTargets = useMemo(
    () => (hostChoices ? hostsToCloneOnto(activeProject, projects, hosts) : []),
    [hostChoices, activeProject, projects, hosts],
  );
  const cloneSource = cloneSession
    ? projects.find((p) => p.id === cloneSession.projectId)
    : undefined;
  const cloneSourceTargets = useMemo(
    () => hostsToCloneOnto(cloneSource, projects, hosts),
    [cloneSource, projects, hosts],
  );

  const openClone = (projectId: string) =>
    setCloneSession((s) => ({ key: (s?.key ?? 0) + 1, projectId, open: true }));
  const closeClone = () => setCloneSession((s) => s && { ...s, open: false });

  /**
   * Once the clone dialog has closed: back to "Clone onto another host…",
   * or, when the clone took the last host and the button went with it, to
   * the chosen host (the new member).
   */
  const focusAfterClone = (e: Event) => {
    e.preventDefault();
    const root = contentRef.current;
    const target =
      root?.querySelector<HTMLElement>('[data-testid="new-workspace-clone-onto-host"]') ??
      root?.querySelector<HTMLElement>(
        '[data-testid="new-workspace-host-picker"] [role="radio"][aria-checked="true"]',
      ) ??
      nameRef.current;
    target?.focus();
  };

  // Fetch remote branches when dialog opens or project changes
  const {
    data: remoteData,
    isLoading: loadingRemote,
    isError: remoteFailed,
  } = useQuery({
    queryKey: ["remote-branches", activeProjectId],
    queryFn: () =>
      window.electronAPI.projects.listRemoteBranches(activeProjectId),
    enabled: open && !!activeProjectId,
  });

  // Fetch local branches
  const {
    data: localData,
    isLoading: loadingLocal,
    isError: localFailed,
  } = useQuery({
    queryKey: ["local-branches", activeProjectId],
    queryFn: () =>
      window.electronAPI.projects.listLocalBranches(activeProjectId),
    enabled: open && !!activeProjectId,
  });

  const loadingBranches = loadingRemote || loadingLocal;
  // Undefined until loaded; a failed load counts as no branches.
  const remoteList = remoteFailed ? NO_BRANCHES : remoteData;
  const localList = localFailed ? NO_BRANCHES : localData;
  const remoteBranches = remoteList ?? NO_BRANCHES;
  const localBranches = localList ?? NO_BRANCHES;

  const allBranchOptions = useMemo(
    () => baseBranchOptions(defaultBranch, remoteBranches),
    [defaultBranch, remoteBranches],
  );
  const existingBranchOptions = useMemo(
    () => listExistingBranchOptions(defaultBranch, localBranches, remoteBranches),
    [defaultBranch, localBranches, remoteBranches],
  );

  const projectOptions = useMemo(() => projectSelectOptions(projects), [projects]);

  // For a linked member, the chosen host must have the branch (ADR-192).
  // Create waits while its branch lists load.
  const branchOnHost =
    hostChoices && activeProject
      ? checkBranchOnHost({
          mode,
          branch: mode === "existing" ? existingBranch : baseBranch,
          defaultBranch,
          localBranches: localList,
          remoteBranches: remoteList,
          hostName: hostLabel(activeProject.hostId, hosts),
        })
      : null;
  const branchMissingMessage =
    branchOnHost?.state === "missing" ? branchOnHost.message : null;
  const waitingForBranches = branchOnHost?.state === "pending";

  /**
   * Move to another member or project, reseeding what belongs to it. Pass
   * `next` for a project this render's `projects` doesn't have yet.
   */
  const chooseProject = (
    projectId: string,
    next = projects.find((p) => p.id === projectId),
  ) => {
    setSelectedProjectId(projectId);
    if (next) setBaseBranch(reseedBaseBranch(baseBranch, baseBranchEdited, next));
    setError(null);
  };

  const folders = useMemo(() => activeProject?.folders ?? [], [activeProject]);
  const folderOptions = useMemo(
    () => [
      { value: "", label: "No folder" },
      ...folders.map((f) => ({ value: f.id, label: f.name })),
    ],
    [folders],
  );
  // A folder belongs to one project; a stale pick would silently vanish.
  const activeFolderId =
    folderId && folders.some((f) => f.id === folderId) ? folderId : null;

  const createWorkspaceFolder = useProjectStore((s) => s.createWorkspaceFolder);
  // Typing a name the folder list doesn't have makes that folder, then picks it.
  const createFolder = useCallback(
    async (folderName: string) => {
      if (!activeProjectId) return;
      try {
        const folder = await createWorkspaceFolder(activeProjectId, folderName);
        if (folder) setFolderId(folder.id);
      } catch (err) {
        setError(
          `Couldn't create folder: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    [activeProjectId, createWorkspaceFolder],
  );

  const handleOpenAutoFocus = useCallback(
    (e: Event) => {
      e.preventDefault();
      setMode("new");
      setName(initialName);
      setBranchName(initialBranch || sanitizeBranchName(initialName));
      setBranchManuallyEdited(!!initialBranch);
      const proj = projects.find(
        (p) =>
          p.id ===
          (preselectedProjectId || projects[selectedProjectIndex]?.id || ""),
      );
      setBaseBranch(proj?.defaultBranch ?? "main");
      setBaseBranchEdited(false);
      setExistingBranch("");
      setSelectedProjectId(defaultProjectId);
      setFolderId(initialFolderId);
      setError(null);
      setIsCreating(false);
      setCloneSession(null);
      // Defer focus to the next frame: the setState calls above re-render the
      // dialog (e.g. switching back to "new" mode unmounts the existing-mode
      // input). Focusing synchronously here lands on the old, about-to-unmount
      // input and the focus is lost. rAF runs after React commits the new tree.
      requestAnimationFrame(() => nameRef.current?.focus());
    },
    [
      defaultProjectId,
      initialBranch,
      initialFolderId,
      initialName,
      preselectedProjectId,
      projects,
      selectedProjectIndex,
    ],
  );

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (isCreating) return;

      const projectId = activeProjectId;
      if (!projectId) {
        setError("No project selected");
        return;
      }
      if (activeHostChoice?.disabledReason) {
        setError(activeHostChoice.disabledReason);
        return;
      }
      if (waitingForBranches) return;
      if (branchMissingMessage) {
        setError(branchMissingMessage);
        return;
      }

      if (mode === "existing") {
        if (!existingBranch) {
          setError("Select a branch");
          return;
        }
        const wsName = name.trim() || existingBranch;
        setError(null);
        setIsCreating(true);
        const success = await onSubmit(
          projectId,
          wsName,
          existingBranch,
          "",
          true,
          activeFolderId,
        );
        if (!success) setIsCreating(false);
        return;
      }

      const trimmedName = name.trim();
      if (!trimmedName) {
        setError("Name is required");
        return;
      }
      if (trimmedName.length > 200) {
        setError("Name must be 200 characters or fewer");
        return;
      }
      const finalBranch = branchName.trim() || sanitizeBranchName(trimmedName);
      if (!finalBranch) {
        setError("Could not derive a valid branch name");
        return;
      }
      setError(null);
      setIsCreating(true);
      const success = await onSubmit(
        projectId,
        trimmedName,
        finalBranch,
        baseBranch,
        false,
        activeFolderId,
      );
      if (!success) {
        setIsCreating(false);
      }
    },
    [
      name,
      branchName,
      baseBranch,
      existingBranch,
      mode,
      activeProjectId,
      activeFolderId,
      activeHostChoice,
      waitingForBranches,
      branchMissingMessage,
      onSubmit,
      isCreating,
    ],
  );

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          ref={contentRef}
          className={styles.dialog}
          data-testid="new-workspace-dialog"
          onOpenAutoFocus={handleOpenAutoFocus}
          onCloseAutoFocus={restoreFocusOnClose}
        >
          <Row align="center" justify="space-between" className={styles.header}>
            <Dialog.Title className={styles.title}>New Workspace</Dialog.Title>
            <Dialog.Close asChild>
              <Button variant="ghost" size="sm" aria-label="Close">
                <X size={14} />
              </Button>
            </Dialog.Close>
          </Row>
          <form onSubmit={handleSubmit}>
            <Stack className={styles.body}>
              <fieldset disabled={isCreating} className={styles.fieldset}>
                {hostChoices && (
                  <HostPicker
                    choices={hostChoices}
                    value={activeProjectId}
                    onChange={chooseProject}
                    onCloneOntoAnotherHost={
                      cloneTargets.length > 0 ? () => openClone(activeProjectId) : undefined
                    }
                  />
                )}
                <ToggleGroup
                  value={mode}
                  onChange={setMode}
                  size="sm"
                  aria-label="New or existing branch"
                  options={[
                    { value: "new", label: "New branch" },
                    { value: "existing", label: "Existing branch" },
                  ]}
                />
                {mode === "existing" ? (
                  <>
                    <Stack>
                      <label className={styles.fieldLabel}>Name</label>
                      <EmojiInput
                        ref={nameRef}
                        type="text"
                        value={name}
                        onChange={(e) => {
                          setName(e.target.value);
                          setError(null);
                        }}
                        placeholder={existingBranch || "Workspace name"}
                        data-testid="new-workspace-name-input"
                      />
                    </Stack>
                    <Stack>
                      <label className={styles.fieldLabel}>Branch</label>
                      <SearchableSelect
                        value={existingBranch}
                        onChange={(val) => {
                          setExistingBranch(val);
                          if (!name.trim()) setName(val);
                          setError(null);
                        }}
                        options={existingBranchOptions.map((b) => ({
                          value: b,
                          label: b,
                        }))}
                        loading={loadingBranches}
                        emptyMessage="No remote branches found"
                        icon={<GitBranch size={12} />}
                        placeholder="Select a branch..."
                      />
                    </Stack>
                  </>
                ) : (
                  <>
                    <Stack>
                      <label className={styles.fieldLabel}>Name</label>
                      <EmojiInput
                        ref={nameRef}
                        type="text"
                        value={name}
                        onChange={(e) => {
                          setName(e.target.value);
                          if (!branchManuallyEdited) {
                            setBranchName(sanitizeBranchName(e.target.value));
                          }
                          setError(null);
                        }}
                        placeholder="My Feature"
                        data-testid="new-workspace-name-input"
                      />
                      <Input
                        variant="ghost"
                        monospace
                        type="text"
                        value={branchName}
                        onChange={(e) => {
                          setBranchName(e.target.value);
                          setBranchManuallyEdited(true);
                        }}
                        placeholder="my-feature"
                      />
                    </Stack>
                  </>
                )}
                {error ? (
                  <div className={styles.error}>{error}</div>
                ) : (
                  branchMissingMessage && (
                    <div className={styles.hint} data-testid="new-workspace-branch-missing">
                      {branchMissingMessage}
                    </div>
                  )
                )}
                <Stack gap="md" className={styles.actions}>
                  <div className={styles.selects}>
                    {projectOptions.length > 1 && (
                      <SearchableSelect
                        value={activeProject ? projectSelectValue(activeProject) : ""}
                        onChange={(value) => {
                          const target = projectForSelectValue(value, projects);
                          if (!target) return;
                          chooseProject(startingMemberId(target, projects, hosts));
                          setFolderId(null);
                        }}
                        options={projectOptions}
                        icon={<Box size={12} />}
                        maxWidth={160}
                        aria-label="Project"
                        data-testid="new-workspace-project-select"
                      />
                    )}
                    {activeProject && (
                      <SearchableSelect
                        value={activeFolderId ?? ""}
                        onChange={(id) => setFolderId(id || null)}
                        onCreate={(folderName) => void createFolder(folderName)}
                        createLabel={(q) => `New folder "${q}"`}
                        options={folderOptions}
                        icon={<Folder size={12} />}
                        maxWidth={140}
                        placeholder="No folder"
                        aria-label="Folder"
                        data-testid="new-workspace-folder-select"
                      />
                    )}
                    {mode === "new" && (
                      <SearchableSelect
                        value={baseBranch}
                        onChange={(branch) => {
                          setBaseBranch(branch);
                          setBaseBranchEdited(true);
                          setError(null);
                        }}
                        options={allBranchOptions.map((b) => ({
                          value: b,
                          label: b,
                        }))}
                        loading={loadingBranches}
                        emptyMessage="No matching branches"
                        icon={<GitBranch size={12} />}
                        maxWidth={180}
                        aria-label="Base branch"
                        data-testid="new-workspace-base-branch-select"
                      />
                    )}
                  </div>
                  <Row gap="sm" justify="flex-end">
                    <Button type="button" variant="secondary" onClick={onClose}>
                      Cancel
                    </Button>
                    <Button
                      type="submit"
                      variant="primary"
                      disabled={isCreating || waitingForBranches}
                      className={styles.submit}
                      data-testid="new-workspace-submit"
                    >
                      {isCreating ? (
                        <>
                          <Loader2 size={14} className={styles.spinner} />
                          Creating...
                        </>
                      ) : (
                        "Create"
                      )}
                    </Button>
                  </Row>
                </Stack>
              </fieldset>
            </Stack>
          </form>
          {cloneSession && cloneSource && (
            <CloneToHostDialog
              key={cloneSession.key}
              open={cloneSession.open}
              mode="addToGroup"
              project={cloneSource}
              hostChoices={cloneSourceTargets}
              onClose={closeClone}
              onCloseAutoFocus={focusAfterClone}
              onCloned={(cloned) => {
                // Continue on the new host, once it has joined the group.
                const memberId = memberAfterClone(cloned, cloneSource.group?.id);
                if (memberId) chooseProject(memberId, cloned);
              }}
            />
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
