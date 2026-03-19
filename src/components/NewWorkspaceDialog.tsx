import { useState, useRef, useCallback } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X, ChevronDown } from "lucide-react";
import type { ProjectInfo } from "../store/project-store";
import styles from "./NewWorkspaceDialog.module.css";

function slugify(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s\-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

interface NewWorkspaceDialogProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (projectId: string, name: string, branch: string) => void;
  projects: ProjectInfo[];
  selectedProjectIndex: number;
}

export function NewWorkspaceDialog({ open, onClose, onSubmit, projects, selectedProjectIndex }: NewWorkspaceDialogProps) {
  const [name, setName] = useState("");
  const [branch, setBranch] = useState("");
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const handleOpenChange = useCallback(
    (isOpen: boolean) => {
      if (!isOpen) onClose();
    },
    [onClose]
  );

  const defaultProjectId = projects[selectedProjectIndex]?.id ?? "";

  const handleOpenAutoFocus = useCallback((e: Event) => {
    e.preventDefault();
    setName("");
    setBranch("");
    setSelectedProjectId(defaultProjectId);
    setError(null);
    nameRef.current?.focus();
  }, [defaultProjectId]);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const trimmedName = name.trim();
      if (!trimmedName) {
        setError("Name is required");
        return;
      }
      if (trimmedName.length > 64) {
        setError("Name must be 64 characters or fewer");
        return;
      }
      const branchName = slugify(branch.trim() || trimmedName);
      if (!branchName) {
        setError("Could not derive a valid branch name");
        return;
      }
      const projectId = selectedProjectId || defaultProjectId;
      if (!projectId) {
        setError("No project selected");
        return;
      }
      setError(null);
      onSubmit(projectId, trimmedName, branchName);
    },
    [name, branch, selectedProjectId, defaultProjectId, onSubmit]
  );

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          className={styles.dialog}
          onOpenAutoFocus={handleOpenAutoFocus}
          onCloseAutoFocus={(e) => { e.preventDefault(); document.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")?.focus(); }}
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
            {projects.length > 1 && (
              <>
                <label className={styles.fieldLabel}>Project</label>
                <div className={styles.selectWrapper}>
                  <select
                    className={styles.fieldSelect}
                    value={selectedProjectId || defaultProjectId}
                    onChange={(e) => setSelectedProjectId(e.target.value)}
                  >
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
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
            <input
              className={styles.fieldInput}
              type="text"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder={slugify(name.trim()) || "defaults to slugified name"}
            />
            {error && <div className={styles.error}>{error}</div>}
            <div className={styles.actions}>
              <button type="button" className={styles.cancelButton} onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className={styles.submitButton}>
                Create
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
