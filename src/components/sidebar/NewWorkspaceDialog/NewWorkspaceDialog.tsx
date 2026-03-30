import { useState, useRef, useCallback, useMemo } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import X from "lucide-react/dist/esm/icons/x";
import Loader2 from "lucide-react/dist/esm/icons/loader-2";
import GitBranch from "lucide-react/dist/esm/icons/git-branch";
import { useQuery } from "@tanstack/react-query";
import type { ProjectInfo } from "../../../store/project-store";
import { Input, Select } from "../../ui/Input";
import { Button } from "../../ui/Button/Button";
import { SearchableSelect } from "../../ui/SearchableSelect";
import styles from "./NewWorkspaceDialog.module.css";
import { Row } from "../../ui/Layout/Layout";

function slugify(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

type NewWorkspaceDialogProps = {
  open: boolean;
  onClose: () => void;
  onSubmit: (
    projectId: string,
    name: string,
    branchName: string,
    baseBranch: string,
  ) => Promise<boolean>;
  projects: ProjectInfo[];
  selectedProjectIndex: number;
  preselectedProjectId?: string | null;
  initialName?: string;
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
  } = props;

  const [name, setName] = useState("");
  const [branchName, setBranchName] = useState("");
  const [branchManuallyEdited, setBranchManuallyEdited] = useState(false);
  const [baseBranch, setBaseBranch] = useState("");
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
  const { data: remoteBranches = [], isLoading: loadingBranches } = useQuery({
    queryKey: ["remote-branches", activeProjectId],
    queryFn: () =>
      window.electronAPI.projects.listRemoteBranches(activeProjectId),
    enabled: open && !!activeProjectId,
  });

  // Build the dropdown item list:
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

  const handleOpenAutoFocus = useCallback(
    (e: Event) => {
      e.preventDefault();
      setName(initialName);
      setBranchName(slugify(initialName));
      setBranchManuallyEdited(false);
      const proj = projects.find(
        (p) =>
          p.id ===
          (preselectedProjectId || projects[selectedProjectIndex]?.id || ""),
      );
      setBaseBranch(proj?.defaultBranch ?? "main");
      setSelectedProjectId(defaultProjectId);
      setError(null);
      setIsCreating(false);
      nameRef.current?.focus();
    },
    [
      defaultProjectId,
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
      const projectId = activeProjectId;
      if (!projectId) {
        setError("No project selected");
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
    [name, branchName, baseBranch, activeProjectId, onSubmit, isCreating],
  );

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          className={styles.dialog}
          onOpenAutoFocus={handleOpenAutoFocus}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            document
              .querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")
              ?.focus();
          }}
        >
          <div className={styles.header}>
            <Dialog.Title className={styles.title}>New Workspace</Dialog.Title>
            <Dialog.Close asChild>
              <Button variant="ghost" size="sm">
                <X size={14} />
              </Button>
            </Dialog.Close>
          </div>
          <form onSubmit={handleSubmit} className={styles.body}>
            <fieldset disabled={isCreating} className={styles.fieldset}>
              {projects.length > 1 && (
                <>
                  <label className={styles.fieldLabel}>Project</label>
                  <Select
                    value={activeProjectId}
                    onChange={(e) => setSelectedProjectId(e.target.value)}
                  >
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </Select>
                </>
              )}
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
              {error && <div className={styles.error}>{error}</div>}
              <div className={styles.actions}>
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
                />
                <Row gap="sm">
                  <Button type="button" variant="secondary" onClick={onClose}>
                    Cancel
                  </Button>
                  <Button type="submit" variant="primary" disabled={isCreating}>
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
              </div>
            </fieldset>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
