import { useState, useRef, useCallback } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import X from "lucide-react/dist/esm/icons/x";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import Loader2 from "lucide-react/dist/esm/icons/loader-2";
import { useQuery } from "@tanstack/react-query";
import type { ProjectInfo } from "../../../store/project-store";
import styles from "./NewWorkspaceDialog.module.css";

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
  const { open, onClose, onSubmit, projects, selectedProjectIndex, preselectedProjectId, initialName = "" } = props;

  const [name, setName] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  // Remote branch picker state
  const [showDropdown, setShowDropdown] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const branchRef = useRef<HTMLInputElement>(null);

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
    queryFn: () => window.electronAPI.projects.listRemoteBranches(activeProjectId),
    enabled: open && !!activeProjectId,
  });

  // Build the dropdown item list:
  // 1. defaultBranch (local)
  // 2. origin/{defaultBranch}
  // 3. all other remote branches prefixed with "origin/" (skip one matching defaultBranch)
  const allBranchOptions = [
    defaultBranch,
    `origin/${defaultBranch}`,
    ...remoteBranches
      .filter((b) => b !== defaultBranch)
      .map((b) => `origin/${b}`),
  ];

  const filteredBranches = baseBranch.trim()
    ? allBranchOptions.filter((b) =>
        b.toLowerCase().includes(baseBranch.trim().toLowerCase()),
      )
    : allBranchOptions;

  const handleOpenAutoFocus = useCallback(
    (e: Event) => {
      e.preventDefault();
      setName(initialName);
      const proj = projects.find((p) => p.id === (preselectedProjectId || projects[selectedProjectIndex]?.id || ""));
      setBaseBranch(proj?.defaultBranch ?? "main");
      setSelectedProjectId(defaultProjectId);
      setError(null);
      setIsCreating(false);
      setShowDropdown(false);
      setHighlightIndex(-1);
      nameRef.current?.focus();
    },
    [defaultProjectId, initialName, preselectedProjectId, projects, selectedProjectIndex],
  );

  const selectBranchOption = useCallback(
    (branchName: string) => {
      setBaseBranch(branchName);
      setShowDropdown(false);
      setHighlightIndex(-1);
    },
    [],
  );

  const handleBranchKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!showDropdown || filteredBranches.length === 0) {
        if (e.key === "ArrowDown" && allBranchOptions.length > 0) {
          e.preventDefault();
          setShowDropdown(true);
          setHighlightIndex(0);
        }
        return;
      }

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setHighlightIndex((i) =>
            i < filteredBranches.length - 1 ? i + 1 : 0,
          );
          break;
        case "ArrowUp":
          e.preventDefault();
          setHighlightIndex((i) =>
            i > 0 ? i - 1 : filteredBranches.length - 1,
          );
          break;
        case "Enter":
          if (highlightIndex >= 0 && highlightIndex < filteredBranches.length) {
            e.preventDefault();
            selectBranchOption(filteredBranches[highlightIndex]);
          }
          break;
        case "Escape":
          e.preventDefault();
          setShowDropdown(false);
          setHighlightIndex(-1);
          break;
      }
    },
    [showDropdown, filteredBranches, highlightIndex, allBranchOptions, selectBranchOption],
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
      const branchName = slugify(trimmedName);
      if (!branchName) {
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
      const success = await onSubmit(projectId, trimmedName, branchName, baseBranch);
      if (!success) {
        setIsCreating(false);
      }
    },
    [name, baseBranch, activeProjectId, onSubmit, isCreating],
  );

  const derivedBranchName = slugify(name);

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
              <button className={styles.closeButton}>
                <X size={14} />
              </button>
            </Dialog.Close>
          </div>
          <form onSubmit={handleSubmit} className={styles.body}>
            <fieldset disabled={isCreating} className={styles.fieldset}>
              {projects.length > 1 && (
                <>
                  <label className={styles.fieldLabel}>Project</label>
                  <div className={styles.selectWrapper}>
                    <select
                      className={styles.fieldSelect}
                      value={activeProjectId}
                      onChange={(e) => setSelectedProjectId(e.target.value)}
                    >
                      {projects.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                    <ChevronDown size={14} className={styles.selectIcon} />
                  </div>
                </>
              )}
              <label className={styles.fieldLabel}>Name</label>
              <input
                ref={nameRef}
                className={styles.fieldInput}
                type="text"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setError(null);
                }}
                placeholder="my-feature"
              />
              {name.trim() && derivedBranchName && (
                <div className={styles.branchHint}>
                  Branch: <span className={styles.branchHintName}>{derivedBranchName}</span>
                </div>
              )}
              <label className={styles.fieldLabel}>Base branch</label>
              <div className={styles.comboboxWrapper}>
                <input
                  ref={branchRef}
                  className={styles.fieldInput}
                  type="text"
                  value={baseBranch}
                  onChange={(e) => {
                    setBaseBranch(e.target.value);
                    setShowDropdown(true);
                    setHighlightIndex(-1);
                  }}
                  onFocus={() => {
                    setShowDropdown(true);
                  }}
                  onBlur={() => {
                    // Delay to allow click on dropdown item
                    setTimeout(() => setShowDropdown(false), 150);
                  }}
                  onKeyDown={handleBranchKeyDown}
                  placeholder="Search branches..."
                  autoComplete="off"
                />
                {showDropdown && (
                  <div className={styles.dropdown}>
                    {loadingBranches ? (
                      <div className={styles.dropdownMessage}>
                        <Loader2 size={12} className={styles.spinner} />
                        Loading branches...
                      </div>
                    ) : filteredBranches.length === 0 ? (
                      <div className={styles.dropdownMessage}>
                        No matching branches
                      </div>
                    ) : (
                      filteredBranches.map((b, i) => (
                        <div
                          key={b}
                          ref={i === highlightIndex ? (el: HTMLDivElement | null) => el?.scrollIntoView({ block: "nearest" }) : undefined}
                          className={`${styles.dropdownItem} ${i === highlightIndex ? styles.dropdownItemHighlighted : ""}`}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            selectBranchOption(b);
                          }}
                          onMouseEnter={() => setHighlightIndex(i)}
                        >
                          {b}
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
              {error && <div className={styles.error}>{error}</div>}
              <div className={styles.actions}>
                <button
                  type="button"
                  className={styles.cancelButton}
                  onClick={onClose}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className={styles.submitButton}
                  disabled={isCreating}
                >
                  {isCreating ? (
                    <>
                      <Loader2 size={14} className={styles.spinner} />
                      Creating...
                    </>
                  ) : (
                    "Create"
                  )}
                </button>
              </div>
            </fieldset>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
