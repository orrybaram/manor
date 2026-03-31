import { useState, useCallback } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Input, Textarea } from "../../../ui/Input/Input";
import { Button } from "../../../ui/Button/Button";
import { useToastStore } from "../../../../store/toast-store";
import styles from "./CommitModal.module.css";

const FLAGS = [
  { key: "--amend", label: "Amend" },
  { key: "--no-verify", label: "No Verify" },
  { key: "--allow-empty", label: "Allow Empty" },
] as const;

type FlagKey = (typeof FLAGS)[number]["key"];

type CommitModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspacePath: string;
  stagedCount: number;
};

export function CommitModal({ open, onOpenChange, workspacePath, stagedCount }: CommitModalProps) {
  const [message, setMessage] = useState("");
  const [description, setDescription] = useState("");
  const [selectedFlags, setSelectedFlags] = useState<Set<FlagKey>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { addToast, updateToast } = useToastStore();

  const reset = useCallback(() => {
    setMessage("");
    setDescription("");
    setSelectedFlags(new Set());
    setError(null);
  }, []);

  const toggleFlag = useCallback((flag: FlagKey) => {
    setSelectedFlags((prev) => {
      const next = new Set(prev);
      if (next.has(flag)) next.delete(flag);
      else next.add(flag);
      return next;
    });
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!message.trim() && !selectedFlags.has("--amend")) return;
    setSubmitting(true);
    setError(null);

    const toastId = "git-commit";
    addToast({ id: toastId, message: "Committing...", status: "loading" });

    try {
      const fullMessage = description.trim()
        ? `${message.trim()}\n\n${description.trim()}`
        : message.trim();

      await window.electronAPI.git.commit(
        workspacePath,
        fullMessage,
        Array.from(selectedFlags),
      );

      updateToast(toastId, { message: "Committed!", status: "success" });
      reset();
      onOpenChange(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Commit failed";
      setError(msg);
      updateToast(toastId, { message: "Commit failed", status: "error", detail: msg });
    } finally {
      setSubmitting(false);
    }
  }, [message, description, selectedFlags, workspacePath, addToast, updateToast, reset, onOpenChange]);

  const canSubmit = (message.trim() || selectedFlags.has("--amend")) && !submitting;

  return (
    <Dialog.Root open={open} onOpenChange={(v) => { if (!v) reset(); onOpenChange(v); }}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          className={styles.dialog}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canSubmit) {
              e.preventDefault();
              handleSubmit();
            }
          }}
        >
          <Dialog.Title className={styles.title}>Commit Changes</Dialog.Title>

          <div className={styles.stagedInfo}>
            <span className={styles.stagedCount}>{stagedCount}</span> staged file{stagedCount !== 1 ? "s" : ""}
          </div>

          <div className={styles.field}>
            <label className={styles.label}>Message</label>
            <Input
              placeholder="Commit message..."
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              autoFocus
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label}>Description (optional)</label>
            <Textarea
              placeholder="Extended description..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label}>Flags</label>
            <div className={styles.flags}>
              {FLAGS.map((flag) => (
                <button
                  key={flag.key}
                  className={selectedFlags.has(flag.key) ? styles.flagSelected : styles.flag}
                  onClick={() => toggleFlag(flag.key)}
                  type="button"
                >
                  {flag.label}
                </button>
              ))}
            </div>
          </div>

          {error && <div className={styles.error}>{error}</div>}

          <div className={styles.actions}>
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleSubmit}
              disabled={!canSubmit}
            >
              Commit
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
