import { useState, useCallback, useRef } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Input, Textarea } from "../../ui/Input/Input";
import { Button } from "../../ui/Button/Button";
import { useToastStore } from "../../../store/toast-store";
import styles from "./FeedbackModal.module.css";

const REPO = "orrybaram/manor";
const TAGS = ["bug", "ux feedback", "feature request"] as const;
type Tag = (typeof TAGS)[number];

interface Screenshot {
  id: string;
  dataUrl: string;
  base64: string;
}

type FeedbackModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

function fileToScreenshot(file: File): Promise<Screenshot> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(",")[1];
      resolve({ id: crypto.randomUUID(), dataUrl, base64 });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function FeedbackModal(props: FeedbackModalProps) {
  const { open, onOpenChange } = props;

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [selectedTag, setSelectedTag] = useState<Tag | null>(null);
  const [screenshots, setScreenshots] = useState<Screenshot[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { addToast, updateToast } = useToastStore();

  const reset = useCallback(() => {
    setTitle("");
    setDescription("");
    setSelectedTag(null);
    setScreenshots([]);
  }, []);

  const toggleTag = useCallback((tag: Tag) => {
    setSelectedTag((prev) => (prev === tag ? null : tag));
  }, []);

  const addScreenshots = useCallback(async (files: FileList | File[]) => {
    const imageFiles = Array.from(files).filter((f) =>
      f.type.startsWith("image/"),
    );
    const newScreenshots = await Promise.all(imageFiles.map(fileToScreenshot));
    setScreenshots((prev) => [...prev, ...newScreenshots]);
  }, []);

  const removeScreenshot = useCallback((id: string) => {
    setScreenshots((prev) => prev.filter((s) => s.id !== id));
  }, []);

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const files = Array.from(e.clipboardData.items)
        .filter((item) => item.type.startsWith("image/"))
        .map((item) => item.getAsFile())
        .filter((f): f is File => f !== null);
      if (files.length > 0) {
        e.preventDefault();
        addScreenshots(files);
      }
    },
    [addScreenshots],
  );

  const handleSubmit = useCallback(async () => {
    if (!title.trim()) return;
    setSubmitting(true);

    const labels = ["user feedback", ...(selectedTag ? [selectedTag] : [])];
    let body = description.trim() || "_No description provided._";

    const toastId = "feedback-submit";
    addToast({
      id: toastId,
      message: "Submitting feedback...",
      status: "loading",
    });

    // Upload screenshots if any
    if (screenshots.length > 0) {
      try {
        const ts = Date.now();
        const images = screenshots.map((s, i) => ({
          base64: s.base64,
          name: `feedback-${ts}-${i}.png`,
        }));
        const urls =
          await window.electronAPI.github.uploadFeedbackImages(images);
        if (urls.length > 0) {
          body +=
            "\n\n---\n\n" +
            urls.map((url, i) => `![screenshot-${i + 1}](${url})`).join("\n");
        }
      } catch {
        // Continue without screenshots
      }
    }

    // Try gh CLI first
    const status = await window.electronAPI.github.checkStatus();

    if (status.installed && status.authenticated) {
      const result = await window.electronAPI.github.createIssue(
        title.trim(),
        body,
        labels,
      );
      if (result?.url) {
        updateToast(toastId, {
          message: "Feedback submitted!",
          status: "success",
          action: {
            label: "View",
            onClick: () => window.electronAPI.shell.openExternal(result.url),
          },
        });
        reset();
        onOpenChange(false);
        setSubmitting(false);
        return;
      }
    }

    // Fallback: open pre-filled GitHub URL in browser
    const params = new URLSearchParams({
      title: title.trim(),
      body,
      labels: labels.join(","),
    });
    const url = `https://github.com/${REPO}/issues/new?${params.toString()}`;
    await window.electronAPI.shell.openExternal(url);

    updateToast(toastId, {
      message: "Opened in browser",
      status: "success",
      detail: "Complete the issue on GitHub",
    });
    reset();
    onOpenChange(false);
    setSubmitting(false);
  }, [
    title,
    description,
    selectedTag,
    screenshots,
    addToast,
    updateToast,
    reset,
    onOpenChange,
  ]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content className={styles.dialog} onPaste={handlePaste} onOpenAutoFocus={(e) => { e.preventDefault(); titleInputRef.current?.focus(); }}>
          <Dialog.Title className={styles.title}>Send Feedback</Dialog.Title>

          <div className={styles.field}>
            <label className={styles.label}>Title</label>
            <Input
              ref={titleInputRef}
              placeholder="Brief summary..."
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label}>Description</label>
            <Textarea
              placeholder="What happened? What did you expect?"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label}>Screenshots</label>
            <div className={styles.screenshots}>
              {screenshots.map((s) => (
                <div key={s.id} className={styles.screenshotThumb}>
                  <img src={s.dataUrl} alt="screenshot" />
                  <button
                    className={styles.screenshotRemove}
                    onClick={() => removeScreenshot(s.id)}
                    type="button"
                  >
                    &times;
                  </button>
                </div>
              ))}
              <button
                className={styles.addScreenshot}
                onClick={() => fileInputRef.current?.click()}
                type="button"
                title="Add screenshot (or paste from clipboard)"
              >
                +
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(e) => {
                  if (e.target.files) addScreenshots(e.target.files);
                  e.target.value = "";
                }}
              />
            </div>
          </div>

          <div className={styles.field}>
            <label className={styles.label}>Tags</label>
            <div className={styles.tags}>
              {TAGS.map((tag) => (
                <button
                  key={tag}
                  className={
                    selectedTag === tag ? styles.tagSelected : styles.tag
                  }
                  onClick={() => toggleTag(tag)}
                  type="button"
                >
                  {tag}
                </button>
              ))}
            </div>
          </div>

          <div className={styles.actions}>
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleSubmit}
              disabled={!title.trim() || submitting}
            >
              Submit
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
