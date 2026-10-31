import X from "lucide-react/dist/esm/icons/x";
import type { ImageAttachment } from "./useImageAttachments";
import styles from "./ImageAttachments.module.css";

type ImageAttachmentsProps = {
  attachments: ImageAttachment[];
  onRemove: (id: string) => void;
  className?: string;
};

/**
 * A composer's attached images as a row of thumbnails, each with × to
 * remove it. One still uploading is dimmed under a spinner; its × cancels it.
 */
export function ImageAttachments(props: ImageAttachmentsProps) {
  const { attachments, onRemove, className } = props;
  if (attachments.length === 0) return null;
  return (
    <ul
      className={className ? `${styles.strip} ${className}` : styles.strip}
      aria-label="Attached images"
      data-testid="image-attachments"
    >
      {attachments.map((a, i) => (
        <li
          key={a.id}
          className={styles.thumb}
          data-uploading={a.path === null || undefined}
          data-testid="image-attachment"
        >
          <img src={a.url} alt={a.file.name || `Image ${i + 1}`} className={styles.image} />
          {a.path === null && (
            <span className={styles.spinner} aria-label="Uploading" role="status" />
          )}
          <button
            type="button"
            className={styles.remove}
            aria-label={`Remove ${a.file.name || `image ${i + 1}`}`}
            onClick={() => onRemove(a.id)}
            data-testid="image-attachment-remove"
          >
            <X size={10} strokeWidth={3} />
          </button>
        </li>
      ))}
    </ul>
  );
}
