import { useState, useRef, useCallback } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
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
  onSubmit: (name: string, branch: string) => void;
}

export function NewWorkspaceDialog({ open, onClose, onSubmit }: NewWorkspaceDialogProps) {
  const [name, setName] = useState("");
  const [branch, setBranch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const handleOpenChange = useCallback(
    (isOpen: boolean) => {
      if (!isOpen) onClose();
    },
    [onClose]
  );

  const handleOpenAutoFocus = useCallback((e: Event) => {
    e.preventDefault();
    setName("");
    setBranch("");
    setError(null);
    nameRef.current?.focus();
  }, []);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const trimmedName = name.trim();
      if (!trimmedName) {
        setError("Name is required");
        return;
      }
      // Validate: no spaces or special chars that break git worktree paths
      if (/[^\w\-.]/.test(trimmedName)) {
        setError("Name can only contain letters, numbers, hyphens, underscores, and dots");
        return;
      }
      const branchName = slugify(branch.trim() || trimmedName);
      if (!branchName) {
        setError("Could not derive a valid branch name");
        return;
      }
      setError(null);
      onSubmit(trimmedName, branchName);
    },
    [name, branch, onSubmit]
  );

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          className={styles.dialog}
          onOpenAutoFocus={handleOpenAutoFocus}
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
