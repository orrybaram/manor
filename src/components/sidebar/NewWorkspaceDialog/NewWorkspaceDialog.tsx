import { useState, useRef, useCallback, useMemo } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import X from "lucide-react/dist/esm/icons/x";
import Loader2 from "lucide-react/dist/esm/icons/loader-2";
import GitBranch from "lucide-react/dist/esm/icons/git-branch";
import Box from "lucide-react/dist/esm/icons/box";
import { useQuery } from "@tanstack/react-query";
import type { ProjectInfo } from "../../../store/project-store";
import { Input } from "../../ui/Input";
import { Button } from "../../ui/Button/Button";
import { SearchableSelect } from "../../ui/SearchableSelect";
import { ToggleGroup } from "../../ui/ToggleGroup";
import styles from "./NewWorkspaceDialog.module.css";
import { Row, Stack } from "../../ui/Layout/Layout";

function slugify(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

type Mode = "new" | "existing";

type NewWorkspaceDialogProps = {
  open: boolean;
  onClose: () => void;
  onSubmit: (
    projectId: string,
    name: string,
    branchName: string,
    baseBranch: string,
    useExistingBranch?: boolean,
  ) => Promise<boolean>;
  projects: ProjectInfo[];
  selectedProjectIndex: number;
  preselectedProjectId?: string | null;
  initialName?: string;
  initialBranch?: string;
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
  } = props;

  const [mode, setMode] = useState<Mode>("new");
  const [name, setName] = useState("");
  const [branchName, setBranchName] = useState("");
  const [branchManuallyEdited, setBranchManuallyEdited] = useState(false);
  const [baseBranch, setBaseBranch] = useState("");
  const [existingBranch, setExistingBranch] = useState("");
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  const handleOpenChange = useCallback(
    (isOpen: boolean) => {
      if (!isOpen && !isCreating) onClose();
    },
    [onClose, isCreating],
  );

  const defaultProjectId =
    preselectedProjectId || projects[selectedProjectIndex]?.id || "";

  const activeProjectId = selectedProjectId || defaultProjectId;

  const activeProject = projects.find((p) => p.id === activeProjectId);
  const defaultBranch = activeProject?.defaultBranch ?? "main";

  // Fetch remote branches when dialog opens or project changes
  const { data: remoteBranches = [], isLoading: loadingRemote } = useQuery({
    queryKey: ["remote-branches", activeProjectId],
    queryFn: () =>
      window.electronAPI.projects.listRemoteBranches(activeProjectId),
    enabled: open && !!activeProjectId,
  });

  // Fetch local branches
  const { data: localBranches = [], isLoading: loadingLocal } = useQuery({
    queryKey: ["local-branches", activeProjectId],
    queryFn: () =>
      window.electronAPI.projects.listLocalBranches(activeProjectId),
    enabled: open && !!activeProjectId,
  });

  const loadingBranches = loadingRemote || loadingLocal;

  // Build the dropdown item list for base branch selection:
  // 1. defaultBranch (local)
  // 2. origin/{defaultBranch}
  // 3. all other remote branches prefixed with "origin/" (skip one matching defaultBranch)
  const allBranchOptions = useMemo(
    () => [
      defaultBranch,
      `origin/${defaultBranch}`,
      ...remoteBranches
        .filter((b) => b !== defaultBranch)
        .map((b) => `origin/${b}`),
    ],
    [defaultBranch, remoteBranches],
  );

  // All branches for "existing branch" mode — local-only branches first, then remote-only
  const existingBranchOptions = useMemo(() => {
    const remoteSet = new Set(remoteBranches);
    const localSet = new Set(localBranches);

    // Local branches that don't exist on remote (truly local-only)
    const localOnly = localBranches.filter(
      (b) => b !== defaultBranch && !remoteSet.has(b),
    );
    // Remote branches (excluding default)
    const remote = remoteBranches.filter((b) => b !== defaultBranch);
    // Branches on both local and remote (excluding default)
    const both = localBranches.filter(
      (b) => b !== defaultBranch && remoteSet.has(b),
    );

    return [...both, ...localOnly, ...remote.filter((b) => !localSet.has(b))];
  }, [remoteBranches, localBranches, defaultBranch]);

  const projectOptions = useMemo(
    () => projects.map((p) => ({ value: p.id, label: p.name })),
    [projects],
  );

  const handleOpenAutoFocus = useCallback(
    (e: Event) => {
      e.preventDefault();
      setMode("new");
      setName(initialName);
      setBranchName(initialBranch || slugify(initialName));
      setBranchManuallyEdited(!!initialBranch);
      const proj = projects.find(
        (p) =>
          p.id ===
          (preselectedProjectId || projects[selectedProjectIndex]?.id || ""),
      );
      setBaseBranch(proj?.defaultBranch ?? "main");
      setExistingBranch("");
      setSelectedProjectId(defaultProjectId);
      setError(null);
      setIsCreating(false);
      nameRef.current?.focus();
    },
    [
      defaultProjectId,
      initialBranch,
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
      const finalBranch = branchName.trim() || slugify(trimmedName);
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
      );
      if (!success) {
        setIsCreating(false);
      }
    },
    [name, branchName, baseBranch, existingBranch, mode, activeProjectId, onSubmit, isCreating],
  );

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          className={styles.dialog}
          data-testid="new-workspace-dialog"
          onOpenAutoFocus={handleOpenAutoFocus}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            document
              .querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")
              ?.focus();
          }}
        >
          <Row align="center" justify="space-between" className={styles.header}>
            <Dialog.Title className={styles.title}>New Workspace</Dialog.Title>
            <Dialog.Close asChild>
              <Button variant="ghost" size="sm">
                <X size={14} />
              </Button>
            </Dialog.Close>
          </Row>
          <form onSubmit={handleSubmit}>
            <Stack className={styles.body}>
              <fieldset disabled={isCreating} className={styles.fieldset}>
                <ToggleGroup
                  value={mode}
                  onChange={setMode}
                  size="sm"
                  options={[
                    { value: "new", label: "New branch" },
                    { value: "existing", label: "Existing branch" },
                  ]}
                />
                {mode === "existing" ? (
                  <>
                    <Stack>
                      <label className={styles.fieldLabel}>Name</label>
                      <Input
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
                      <Input
                        ref={nameRef}
                        type="text"
                        value={name}
                        onChange={(e) => {
                          setName(e.target.value);
                          if (!branchManuallyEdited) {
                            setBranchName(slugify(e.target.value));
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
                {error && <div className={styles.error}>{error}</div>}
                <Row justify="space-between" gap="sm" className={styles.actions}>
                  <Row gap="sm">
                    {projects.length > 1 && (
                      <SearchableSelect
                        value={activeProjectId}
                        onChange={setSelectedProjectId}
                        options={projectOptions}
                        icon={<Box size={12} />}
                        maxWidth={160}
                        data-testid="new-workspace-project-select"
                      />
                    )}
                    {mode === "new" && (
                      <SearchableSelect
                        value={baseBranch}
                        onChange={setBaseBranch}
                        options={allBranchOptions.map((b) => ({
                          value: b,
                          label: b,
                        }))}
                        loading={loadingBranches}
                        emptyMessage="No matching branches"
                        icon={<GitBranch size={12} />}
                        maxWidth={180}
                        data-testid="new-workspace-base-branch-select"
                      />
                    )}
                  </Row>
                  <Row gap="sm">
                    <Button type="button" variant="secondary" onClick={onClose}>
                      Cancel
                    </Button>
                    <Button type="submit" variant="primary" disabled={isCreating} data-testid="new-workspace-submit">
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
                </Row>
              </fieldset>
            </Stack>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
