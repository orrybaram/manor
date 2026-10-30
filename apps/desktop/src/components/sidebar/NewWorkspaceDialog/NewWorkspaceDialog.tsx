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
import { usePreferencesStore } from "../../../store/preferences-store";
import { Input } from "../../ui/Input";
import { EmojiInput, EmojiTextarea } from "../../ui/EmojiAutocomplete";
import { Button } from "../../ui/Button/Button";
import { SearchableSelect } from "../../ui/SearchableSelect";
import styles from "./NewWorkspaceDialog.module.css";
import { Row } from "../../ui/Layout/Layout";
import { sanitizeBranchName } from "../../../utils/branch-name";
import { useRestoreFocus } from "../../../hooks/useRestoreFocus";
import { useHostStore } from "../../../store/host-store";
import { hostSentenceName } from "../../../bridge/server-set";
import { hasHiddenPods, newHostTargets, transferTargets } from "../../../lib/transfer-targets";
import { useHostProfileStore } from "../../../store/host-profile-store";
import {
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
import {
  applySuggestionResult,
  shouldSuggest,
  type SuggestSnapshot,
} from "./folder-suggestion";
import type { FolderPick } from "@manor/protocol/jev-protocol";
import { useMountEffect } from "../../../hooks/useMountEffect";
import { useSourcedHosts } from "../../../hooks/useHostDisplay";
import { CloneToHostDialog } from "../../hosts/CloneToHostDialog";

type Mode = "new" | "existing";

const NO_BRANCHES: string[] = [];
/** A folder name past this is a sidebar label nobody can read. */
const FOLDER_NAME_MAX = 60;

/** The branch chip's values: a base branch to branch off, or a branch to check out. */
const NEW_PREFIX = "new:";
const EXISTING_PREFIX = "existing:";

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
    /** First message for an agent started in the new workspace; none when empty. */
    agentPrompt?: string,
  ) => Promise<boolean>;
  projects: ProjectInfo[];
  selectedProjectIndex: number;
  preselectedProjectId?: string | null;
  initialName?: string;
  initialBranch?: string;
  /** Folder preselected when the dialog opens from a folder's own menu. */
  initialFolderId?: string | null;
  /** Prefills the agent prompt, e.g. when the dialog is opened from a task. */
  initialAgentPrompt?: string;
  /**
   * For a linked project: the member the host picker starts on
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
    initialAgentPrompt = "",
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
  // Set by any hand pick; stops Jev suggesting over the user's choice.
  const [folderTouched, setFolderTouched] = useState(false);
  const [suggestion, setSuggestion] = useState<FolderPick | null>(null);
  // A request is in flight: the folder picker shimmers until it answers.
  const [suggesting, setSuggesting] = useState(false);
  const suggestionsEnabled = usePreferencesStore(
    (s) => s.preferences.folderSuggestionsEnabled,
  );
  const [agentPrompt, setAgentPrompt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  /**
   * "Set up on another host…": the project it was opened from, pinned so
   * the set up keeps its source while the new project joins and becomes the
   * selection. `key` gives each opening a fresh dialog, and `open` false
   * keeps the closed one mounted while its exit animation plays.
   */
  const [cloneSession, setCloneSession] = useState<{
    key: number;
    projectId: string;
    open: boolean;
  } | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const suggestTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  // Bumped by every cancel, so a reply for an older draft is dropped.
  const suggestRequestRef = useRef(0);

  /** Drops a pending or in-flight suggestion: the draft or the choice moved on. */
  const cancelSuggestion = useCallback(() => {
    clearTimeout(suggestTimerRef.current);
    suggestRequestRef.current++;
    setSuggesting(false);
  }, []);
  useMountEffect(() => () => clearTimeout(suggestTimerRef.current));

  const handleOpenChange = useCallback(
    (isOpen: boolean) => {
      if (!isOpen && !isCreating) {
        cancelSuggestion();
        onClose();
      }
    },
    [onClose, isCreating, cancelSuggestion],
  );

  const hosts = useHostStore((s) => s.hosts);
  const sourcedHosts = useSourcedHosts();

  // A linked project creates in one member: the one the host picker starts
  // on. Anything else is created in as it is.
  const defaultProjectId = startingMemberId(
    preselectedProjectId || projects[selectedProjectIndex]?.id || "",
    projects,
    sourcedHosts,
    preferredMemberId,
  );

  const activeProjectId = selectedProjectId || defaultProjectId;

  const activeProject = projects.find((p) => p.id === activeProjectId);
  const defaultBranch = activeProject?.defaultBranch ?? "main";
  const hostChoices = useMemo(
    () => workspaceHostChoices(activeProject, projects, sourcedHosts),
    [activeProject, projects, sourcedHosts],
  );
  const activeHostChoice = hostChoices?.find(
    (c) => c.projectId === activeProjectId,
  );
  // Other projects' pods are left out of the targets until asked for.
  const [showAllHosts, setShowAllHosts] = useState(false);
  const cloneTargets = useMemo(
    () =>
      activeProject
        ? transferTargets(activeProject, projects, hosts, "copy", { showAllHosts })
        : [],
    [activeProject, projects, hosts, showAllHosts],
  );
  const hiddenPods = activeProject ? hasHiddenPods(activeProject, hosts) : false;
  const profiles = useHostProfileStore((s) => s.profiles);
  const podTargets = useMemo(() => newHostTargets(profiles), [profiles]);
  const openInNewHost = useProjectStore((s) => s.openInNewHost);
  // A lone project gets a one-choice picker, so it has the button too.
  const pickerChoices = useMemo(
    () =>
      hostChoices ??
      (activeProject && (cloneTargets.length > 0 || podTargets.length > 0)
        ? [{ projectId: activeProject.id, hostId: activeProject.hostId, disabledReason: null }]
        : null),
    [hostChoices, activeProject, cloneTargets, podTargets],
  );
  const cloneSource = cloneSession
    ? projects.find((p) => p.id === cloneSession.projectId)
    : undefined;
  const cloneSourceTargets = useMemo(
    () =>
      cloneSource
        ? transferTargets(cloneSource, projects, hosts, "copy", { showAllHosts })
        : [],
    [cloneSource, projects, hosts, showAllHosts],
  );

  const openClone = (projectId: string) =>
    setCloneSession((s) => ({ key: (s?.key ?? 0) + 1, projectId, open: true }));
  const closeClone = () => setCloneSession((s) => s && { ...s, open: false });

  /** Once the set-up dialog has closed: back to the host chip it was opened from. */
  const focusAfterClone = (e: Event) => {
    e.preventDefault();
    const target =
      contentRef.current?.querySelector<HTMLElement>(
        '[data-testid="new-workspace-host-picker"]',
      ) ?? nameRef.current;
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
    () =>
      listExistingBranchOptions(defaultBranch, localBranches, remoteBranches),
    [defaultBranch, localBranches, remoteBranches],
  );

  const projectOptions = useMemo(
    () => projectSelectOptions(projects),
    [projects],
  );

  // For a linked member, the chosen host must have the branch.
  // Create waits while its branch lists load.
  const branchOnHost =
    hostChoices && activeProject
      ? checkBranchOnHost({
          mode,
          branch: mode === "existing" ? existingBranch : baseBranch,
          defaultBranch,
          localBranches: localList,
          remoteBranches: remoteList,
          hostName: hostSentenceName(activeProject.hostId, hosts),
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
    { keepFolder = true }: { keepFolder?: boolean } = {},
  ) => {
    setSelectedProjectId(projectId);
    if (next)
      setBaseBranch(reseedBaseBranch(baseBranch, baseBranchEdited, next));
    setError(null);
    if (!keepFolder) {
      setFolderId(null);
      setSuggestion(null);
    }
    const nextFolders = next?.folders ?? [];
    const kept =
      keepFolder && nextFolders.some((f) => f.id === activeFolderId)
        ? { folderId: activeFolderId, suggestion }
        : { folderId: null, suggestion: null };
    scheduleSuggestion({
      projectId,
      folderCount: nextFolders.length,
      choice: kept,
    });
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

  /**
   * Ask Jev for a folder once the draft settles, unless the user has chosen.
   * Every handler that changes the draft calls this with what it is about to
   * change; the rest comes from this render.
   */
  const scheduleSuggestion = (changes: Partial<SuggestSnapshot> = {}) => {
    cancelSuggestion();
    const snapshot: SuggestSnapshot = {
      projectId: activeProjectId,
      folderCount: folders.length,
      name,
      branchName,
      agentPrompt,
      folderTouched,
      choice: { folderId: activeFolderId, suggestion },
      ...changes,
    };
    if (!shouldSuggest({ ...snapshot, suggestionsEnabled, initialFolderId })) {
      return;
    }
    const request = suggestRequestRef.current;
    suggestTimerRef.current = setTimeout(() => {
      setSuggesting(true);
      window.electronAPI.jev
        .suggestFolder(snapshot.projectId, {
          name: snapshot.name,
          branchName: snapshot.branchName,
          agentPrompt: snapshot.agentPrompt || undefined,
        })
        .then((result) => {
          if (request !== suggestRequestRef.current) return;
          const next = applySuggestionResult(snapshot.choice, result);
          setFolderId(next.folderId);
          setSuggestion(next.suggestion);
        })
        // A suggestion is a nicety; a failed one leaves the choice alone.
        .catch(() => {})
        .finally(() => {
          if (request === suggestRequestRef.current) setSuggesting(false);
        });
    }, 400);
  };

  const createWorkspaceFolder = useProjectStore((s) => s.createWorkspaceFolder);
  // Typing a name the folder list doesn't have makes that folder, then picks it.
  const createFolder = useCallback(
    async (folderName: string) => {
      if (!activeProjectId) return;
      try {
        const folder = await createWorkspaceFolder(activeProjectId, folderName);
        if (folder) {
          cancelSuggestion();
          setFolderId(folder.id);
          setFolderTouched(true);
        }
      } catch (err) {
        setError(
          `Couldn't create folder: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    [activeProjectId, cancelSuggestion, createWorkspaceFolder],
  );

  // Not memoised: it schedules a suggestion from this render's state.
  const handleOpenAutoFocus = (e: Event) => {
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
    setFolderTouched(false);
    setSuggestion(null);
    setAgentPrompt(initialAgentPrompt);
    scheduleSuggestion({
      projectId: defaultProjectId,
      folderCount:
        projects.find((p) => p.id === defaultProjectId)?.folders.length ?? 0,
      name: initialName,
      branchName: initialBranch || sanitizeBranchName(initialName),
      agentPrompt: initialAgentPrompt,
      folderTouched: false,
      choice: { folderId: initialFolderId, suggestion: null },
    });
    setError(null);
    setIsCreating(false);
    setCloneSession(null);
    // Defer focus to the next frame: the setState calls above re-render the
    // dialog (e.g. switching back to "new" mode unmounts the existing-mode
    // input). Focusing synchronously here lands on the old, about-to-unmount
    // input and the focus is lost. rAF runs after React commits the new tree.
    requestAnimationFrame(() => nameRef.current?.focus());
  };

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
      // An empty prompt starts no agent.
      const promptToSend = agentPrompt.trim() || undefined;

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
          promptToSend,
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
        promptToSend,
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
      agentPrompt,
      waitingForBranches,
      branchMissingMessage,
      onSubmit,
      isCreating,
    ],
  );

  const branchOptions = useMemo(
    () => [
      ...allBranchOptions.map((b) => ({
        value: NEW_PREFIX + b,
        label: b,
        group: "New branch off",
      })),
      ...existingBranchOptions.map((b) => ({
        value: EXISTING_PREFIX + b,
        label: b,
        group: "Check out existing",
      })),
    ],
    [allBranchOptions, existingBranchOptions],
  );

  /** The branch chip's pick: branch off a base, or check out an existing branch. */
  const chooseBranch = (value: string) => {
    setError(null);
    if (value.startsWith(NEW_PREFIX)) {
      setMode("new");
      setBaseBranch(value.slice(NEW_PREFIX.length));
      setBaseBranchEdited(true);
      // A name filled in from a checked-out branch names the new branch too.
      if (!branchManuallyEdited) {
        const nextBranch = sanitizeBranchName(name);
        setBranchName(nextBranch);
        scheduleSuggestion({ branchName: nextBranch });
      }
      return;
    }
    const branch = value.slice(EXISTING_PREFIX.length);
    setMode("existing");
    setExistingBranch(branch);
    if (!name.trim()) {
      setName(branch);
      scheduleSuggestion({ name: branch });
    }
  };

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
          <Dialog.Close asChild>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Close"
              className={styles.close}
            >
              <X size={14} />
            </Button>
          </Dialog.Close>
          <form ref={formRef} onSubmit={handleSubmit}>
            <fieldset disabled={isCreating} className={styles.fieldset}>
              <div className={styles.top}>
                <Dialog.Title className={styles.srOnly}>
                  New Workspace
                </Dialog.Title>
                <EmojiInput
                  ref={nameRef}
                  type="text"
                  value={name}
                  className={styles.nameInput}
                  aria-label="Workspace name"
                  onChange={(e) => {
                    const nextName = e.target.value;
                    setName(nextName);
                    setError(null);
                    if (mode === "existing") {
                      scheduleSuggestion({ name: nextName });
                      return;
                    }
                    const nextBranch = branchManuallyEdited
                      ? branchName
                      : sanitizeBranchName(nextName);
                    setBranchName(nextBranch);
                    scheduleSuggestion({
                      name: nextName,
                      branchName: nextBranch,
                    });
                  }}
                  placeholder={
                    mode === "existing"
                      ? existingBranch || "Workspace name"
                      : "New workspace"
                  }
                  data-testid="new-workspace-name-input"
                />
                <Row gap="xs" align="center" className={styles.branchLine}>
                  <GitBranch size={11} aria-hidden />
                  {mode === "existing" ? (
                    <span data-testid="new-workspace-checks-out">
                      Checks out{" "}
                      <span className={styles.branchName}>{existingBranch}</span>
                    </span>
                  ) : (
                    <Input
                      variant="ghost"
                      monospace
                      type="text"
                      value={branchName}
                      className={styles.branchInput}
                      aria-label="Branch name"
                      onChange={(e) => {
                        setBranchName(e.target.value);
                        setBranchManuallyEdited(true);
                        scheduleSuggestion({ branchName: e.target.value });
                      }}
                      placeholder="new-workspace"
                      data-testid="new-workspace-branch-input"
                    />
                  )}
                </Row>
              </div>
              <div className={styles.composer}>
                <EmojiTextarea
                  value={agentPrompt}
                  className={styles.prompt}
                  onChange={(e) => {
                    setAgentPrompt(e.target.value);
                    scheduleSuggestion({ agentPrompt: e.target.value });
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      formRef.current?.requestSubmit();
                    }
                  }}
                  placeholder="What should the agent work on? (optional)"
                  rows={initialAgentPrompt ? 6 : 3}
                  aria-label="Agent prompt"
                  data-testid="new-workspace-agent-prompt"
                />
                <div className={styles.chips} data-testid="new-workspace-chips">
                  {pickerChoices && (
                    <HostPicker
                      choices={pickerChoices}
                      value={activeProjectId}
                      onChange={chooseProject}
                      onSetUpOnAnotherHost={
                        cloneTargets.length > 0
                          ? () => openClone(activeProjectId)
                          : undefined
                      }
                      showHiddenHostsToggle={hiddenPods}
                      showAllHosts={showAllHosts}
                      onToggleShowAllHosts={() => setShowAllHosts((v) => !v)}
                      newHostTargets={podTargets}
                      onSetUpInNewHost={(target) =>
                        void openInNewHost({
                          profileId: target.profileId,
                          sourceProjectId: activeProjectId,
                        })
                      }
                    />
                  )}
                  {projectOptions.length > 1 && (
                    <SearchableSelect
                      value={
                        activeProject ? projectSelectValue(activeProject) : ""
                      }
                      onChange={(value) => {
                        const target = projectForSelectValue(value, projects);
                        if (!target) return;
                        chooseProject(
                          startingMemberId(target, projects, sourcedHosts),
                          undefined,
                          { keepFolder: false },
                        );
                      }}
                      options={projectOptions}
                      icon={<Box size={12} />}
                      className={styles.chip}
                      maxWidth={130}
                      aria-label="Project"
                      data-testid="new-workspace-project-select"
                    />
                  )}
                  {activeProject && (
                    <SearchableSelect
                      value={activeFolderId ?? ""}
                      onChange={(id) => {
                        cancelSuggestion();
                        setFolderId(id || null);
                        setFolderTouched(true);
                      }}
                      onCreate={(folderName) => void createFolder(folderName)}
                      createLabel={(q) => `New folder "${q}"`}
                      searchMaxLength={FOLDER_NAME_MAX}
                      options={folderOptions}
                      icon={<Folder size={12} />}
                      maxWidth={120}
                      placeholder="No folder"
                      aria-label="Folder"
                      className={
                        suggesting
                          ? `${styles.chip} ${styles.folderSuggesting}`
                          : styles.chip
                      }
                      data-testid="new-workspace-folder-select"
                    />
                  )}
                  <SearchableSelect
                    value={
                      mode === "existing"
                        ? existingBranch && EXISTING_PREFIX + existingBranch
                        : NEW_PREFIX + baseBranch
                    }
                    onChange={chooseBranch}
                    options={branchOptions}
                    triggerLabel={
                      mode === "existing" ? (
                        <span className={styles.branchName}>
                          {existingBranch || "Pick a branch"}
                        </span>
                      ) : (
                        <>
                          <span className={styles.chipDim}>off</span>{" "}
                          <span className={styles.branchName}>{baseBranch}</span>
                        </>
                      )
                    }
                    loading={loadingBranches}
                    emptyMessage="No matching branches"
                    searchPlaceholder="Search branches..."
                    icon={<GitBranch size={12} />}
                    className={styles.chip}
                    maxWidth={170}
                    listMaxHeight={260}
                    aria-label="Branch"
                    data-testid="new-workspace-base-branch-select"
                  />
                </div>
              </div>
              {error ? (
                <div className={styles.error}>{error}</div>
              ) : (
                branchMissingMessage && (
                  <div
                    className={styles.hint}
                    data-testid="new-workspace-branch-missing"
                  >
                    {branchMissingMessage}
                  </div>
                )
              )}
              <Row gap="sm" justify="flex-end" className={styles.actions}>
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
            </fieldset>
          </form>
          {cloneSession && cloneSource && (
            <CloneToHostDialog
              key={cloneSession.key}
              open={cloneSession.open}
              mode="setUp"
              project={cloneSource}
              hostChoices={cloneSourceTargets}
              onClose={closeClone}
              onCloseAutoFocus={focusAfterClone}
              onSetUp={(hostId) => {
                // Continue on the new host, once it has joined the project's
                // group. A set up that needed input or failed joined nothing.
                const state = useProjectStore.getState().projects;
                const groupId = state.find((p) => p.id === cloneSource.id)?.group?.id;
                const added = state.find(
                  (p) => p.hostId === hostId && groupId && p.group?.id === groupId,
                );
                const memberId = added && memberAfterClone(added, groupId);
                if (memberId) chooseProject(memberId, added);
              }}
            />
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
