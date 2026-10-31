import ImagePlus from "lucide-react/dist/esm/icons/image-plus";
import { useRef, useState, type ClipboardEvent, type MutableRefObject, type RefObject } from "react";
import { isWebApp } from "../../../lib/platform";
import { Button } from "../../ui/Button/Button";
import styles from "./ChatPane.module.css";

// Naming the types (not `image/*`) also has iOS hand over a HEIC photo as JPEG.
const PICKABLE_IMAGE_TYPES = "image/png,image/jpeg,image/gif,image/webp";

/** The composer's text and caret as last seen, for an upload that finishes after more typing. */
export type ComposerSnapshot = { text: string; caret: number };

type UseImageAttachOptions = {
  /** Uploads the image to the host the message goes to; resolves to its path there. */
  upload: (file: File) => Promise<string>;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  latestRef: MutableRefObject<ComposerSnapshot>;
  /** Sets the composer's text and caret. */
  fill: (text: string, caret: number) => void;
  setError: (error: string | null) => void;
};

/**
 * A chat composer's images: pasted, or picked in the browser;
 * each is uploaded and its path typed at the caret it was added at.
 */
export function useImageAttach(opts: UseImageAttachOptions) {
  const { upload, inputRef, latestRef, fill, setError } = opts;

  // Images still uploading; a count, so the first to finish doesn't end the
  // hint for another.
  const [uploads, setUploads] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Uploads an image and types its path at `at`, the caret when the image
  // was pasted or picked.
  const attachImage = (file: File, before: string, at: number): Promise<void> => {
    setUploads((n) => n + 1);
    setError(null);
    return upload(file)
      .then(
        (path) => {
          // The text may have changed during the upload. Insert where the
          // paste was if everything before it is as it was, else at the end;
          // the caret stays where the user left it.
          const now = latestRef.current;
          const insert = path + " ";
          const anchor =
            now.text.slice(0, at) === before.slice(0, at) ? at : now.text.length;
          const caretAfter =
            now.caret >= anchor ? now.caret + insert.length : now.caret;
          fill(now.text.slice(0, anchor) + insert + now.text.slice(anchor), caretAfter);
        },
        (err: unknown) => setError(err instanceof Error ? err.message : "Couldn't paste image"),
      )
      .finally(() => setUploads((n) => n - 1));
  };

  // A pasted image is uploaded to the pane's host rather than pasted. Pasted
  // text is left to the textarea.
  const pasteImage = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const data = e.clipboardData;
    if (Array.from(data.types).includes("text/plain")) return;
    const file = Array.from(data.items)
      .find((item) => item.kind === "file" && item.type.startsWith("image/"))
      ?.getAsFile();
    if (!file) return;
    e.preventDefault();
    const text = e.currentTarget.value;
    void attachImage(file, text, e.currentTarget.selectionStart ?? text.length);
  };

  // Images picked with the attach button, for phones that can't copy an
  // image (Android). One at a time, so their paths land in the order picked.
  const pickImages = async (files: File[]) => {
    // The textarea keeps its selection after losing focus to the button, and
    // a plain caret move doesn't fire `select`, so `latestRef` may be behind.
    const el = inputRef.current;
    if (el) latestRef.current = { text: el.value, caret: el.selectionStart };
    for (const file of files) {
      const now = latestRef.current;
      await attachImage(file, now.text, now.caret);
    }
  };

  const attachButton = isWebApp() ? (
    <>
      <Button
        variant="ghost"
        className={styles.composerAttach}
        aria-label="Attach image"
        onClick={() => fileInputRef.current?.click()}
        data-testid="chat-attach"
      >
        <ImagePlus size={18} />
      </Button>
      <input
        ref={fileInputRef}
        type="file"
        accept={PICKABLE_IMAGE_TYPES}
        multiple
        hidden
        data-testid="chat-attach-input"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          void pickImages(files);
        }}
      />
    </>
  ) : null;

  return { uploading: uploads > 0, pasteImage, attachButton };
}
