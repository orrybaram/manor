import { useState, useRef, useCallback, useEffect } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X, ChevronDown, Loader2 } from "lucide-react";
import type { ProjectInfo } from "../store/project-store";
import styles from "./NewWorkspaceDialog.module.css";

function slugify(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

interface NewWorkspaceDialogProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (
    projectId: string,
    name: string,
    branch: string,
  ) => Promise<boolean>;
  projects: ProjectInfo[];
  selectedProjectIndex: number;
  preselectedProjectId?: string | null;
  initialName?: string;
  initialBranch?: string;
}

export function NewWorkspaceDialog({
  open,
  onClose,
  onSubmit,
  projects,
  selectedProjectIndex,
  preselectedProjectId,
  initialName = "",
  initialBranch = "",
}: NewWorkspaceDialogProps) {
  const [name, setName] = useState("");
  const [branch, setBranch] = useState("");
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  // Remote branch picker state
  const [remoteBranches, setRemoteBranches] = useState<string[]>([]);
  const [loadingBranches, setLoadingBranches] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const branchRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const handleOpenChange = useCallback(
    (isOpen: boolean) => {
      if (!isOpen && !isCreating) onClose();
    },
    [onClose, isCreating],
  );

  const defaultProjectId =
    preselectedProjectId || projects[selectedProjectIndex]?.id || "";

  const activeProjectId = selectedProjectId || defaultProjectId;

  // Fetch remote branches when dialog opens or project changes
  useEffect(() => {
    if (!open || !activeProjectId) {
      setRemoteBranches([]);
      return;
    }
    let cancelled = false;
    setLoadingBranches(true);
    window.electronAPI.projects
      .listRemoteBranches(activeProjectId)
      .then((branches) => {
        if (!cancelled) setRemoteBranches(branches);
      })
      .catch(() => {
        if (!cancelled) setRemoteBranches([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingBranches(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, activeProjectId]);

  const filteredBranches = branch.trim()
    ? remoteBranches.filter((b) =>
        b.toLowerCase().includes(branch.trim().toLowerCase()),
      )
    : remoteBranches;

  const handleOpenAutoFocus = useCallback(
    (e: Event) => {
      e.preventDefault();
      setName(initialName);
      setBranch(initialBranch);
      setSelectedProjectId(defaultProjectId);
      setError(null);
      setIsCreating(false);
      setShowDropdown(false);
      setHighlightIndex(-1);
      nameRef.current?.focus();
    },
    [defaultProjectId, initialName, initialBranch],
  );

  const selectBranch = useCallback(
    (branchName: string) => {
      setBranch(branchName);
      if (!name.trim()) {
        setName(branchName);
      }
      setShowDropdown(false);
      setHighlightIndex(-1);
    },
    [name],
  );

  const handleBranchKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!showDropdown || filteredBranches.length === 0) {
        if (e.key === "ArrowDown" && remoteBranches.length > 0) {
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
            selectBranch(filteredBranches[highlightIndex]);
          }
          break;
        case "Escape":
          e.preventDefault();
          setShowDropdown(false);
          setHighlightIndex(-1);
          break;
      }
    },
    [showDropdown, filteredBranches, highlightIndex, remoteBranches, selectBranch],
  );

  // Scroll highlighted item into view
  useEffect(() => {
    if (highlightIndex < 0 || !dropdownRef.current) return;
    const item = dropdownRef.current.children[highlightIndex] as HTMLElement;
    item?.scrollIntoView({ block: "nearest" });
  }, [highlightIndex]);

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
      const trimmedBranch = branch.trim();
      const branchName = trimmedBranch || slugify(trimmedName);
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
      const success = await onSubmit(projectId, trimmedName, branchName);
      if (!success) {
        setIsCreating(false);
      }
    },
    [name, branch, activeProjectId, onSubmit, isCreating],
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
              <label className={styles.fieldLabel}>Branch</label>
              <div className={styles.comboboxWrapper}>
                <input
                  ref={branchRef}
                  className={styles.fieldInput}
                  type="text"
                  value={branch}
                  onChange={(e) => {
                    setBranch(e.target.value);
                    setShowDropdown(true);
                    setHighlightIndex(-1);
                  }}
                  onFocus={() => {
                    if (remoteBranches.length > 0) setShowDropdown(true);
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
                  <div className={styles.dropdown} ref={dropdownRef}>
                    {loadingBranches ? (
                      <div className={styles.dropdownMessage}>
                        <Loader2 size={12} className={styles.spinner} />
                        Loading branches...
                      </div>
                    ) : filteredBranches.length === 0 ? (
                      <div className={styles.dropdownMessage}>
                        {remoteBranches.length === 0
                          ? "No remote branches found"
                          : "No matching branches"}
                      </div>
                    ) : (
                      filteredBranches.map((b, i) => (
                        <div
                          key={b}
                          className={`${styles.dropdownItem} ${i === highlightIndex ? styles.dropdownItemHighlighted : ""}`}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            selectBranch(b);
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
