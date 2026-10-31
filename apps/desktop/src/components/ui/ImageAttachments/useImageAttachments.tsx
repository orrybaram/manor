import ImagePlus from "lucide-react/dist/esm/icons/image-plus";
import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
} from "react";
import { useMountEffect } from "../../../hooks/useMountEffect";
import { Button } from "../Button/Button";

// Naming the types (not `image/*`) also has iOS hand over a HEIC photo as JPEG.
const PICKABLE_IMAGE_TYPES = "image/png,image/jpeg,image/gif,image/webp";

/** An image added to a composer: shown from its file, sent as its path on the host. */
export type ImageAttachment = {
  id: string;
  file: File;
  /** An object URL of the file, for the thumbnail. */
  url: string;
  /** Its path on the host once uploaded; null while uploading. */
  path: string | null;
  /** Which upload `path` answers; a host change starts a new one. */
  gen: number;
};

type UseImageAttachmentsOptions = {
  /** Uploads the image to the host the message goes to; resolves to its path there. */
  upload: (file: File) => Promise<string>;
  /**
   * The host the message goes to. When it changes, every image is uploaded
   * again, so the paths sent are on the host that reads them.
   */
  target?: string;
  setError: (error: string | null) => void;
  /** Styles the attach button. */
  buttonClassName?: string;
};

let nextId = 0;

function imageFiles(files: Iterable<File>): File[] {
  return Array.from(files).filter((f) => f.type.startsWith("image/"));
}

/** True when a drag carries files, so the composer takes the drop. */
function draggingFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer.types).includes("Files");
}

/**
 * A composer's images: pasted, picked with the attach button, or dropped.
 * Each uploads to the host at once and shows as a thumbnail until it is
 * removed or sent; the text never holds its path. `withPaths` adds the
 * paths to the message on send.
 */
export function useImageAttachments(opts: UseImageAttachmentsOptions) {
  const { target, setError, buttonClassName } = opts;
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Read from upload callbacks and effects, which outlive the render that
  // started them.
  const listRef = useRef(attachments);
  listRef.current = attachments;
  const uploadRef = useRef(opts.upload);
  uploadRef.current = opts.upload;

  const start = (attachment: ImageAttachment) => {
    const { id, gen } = attachment;
    uploadRef.current(attachment.file).then(
      (path) =>
        setAttachments((list) =>
          list.map((a) => (a.id === id && a.gen === gen ? { ...a, path } : a)),
        ),
      (err: unknown) => {
        // A removed image, or one a host change uploads again, has no
        // failure to show.
        const current = listRef.current.find((a) => a.id === id);
        if (!current || current.gen !== gen) return;
        URL.revokeObjectURL(current.url);
        setAttachments((list) => list.filter((a) => a.id !== id));
        setError(err instanceof Error ? err.message : "Couldn't attach image");
      },
    );
  };

  const add = (files: File[]) => {
    if (files.length === 0) return;
    setError(null);
    const added = files.map((file) => ({
      id: `image-${++nextId}`,
      file,
      url: URL.createObjectURL(file),
      path: null,
      gen: 0,
    }));
    listRef.current = [...listRef.current, ...added];
    setAttachments(listRef.current);
    added.forEach(start);
  };

  const remove = (id: string) => {
    const gone = listRef.current.find((a) => a.id === id);
    if (gone) URL.revokeObjectURL(gone.url);
    listRef.current = listRef.current.filter((a) => a.id !== id);
    setAttachments(listRef.current);
  };

  /** Drops every image, after a send. */
  const clear = () => {
    for (const a of listRef.current) URL.revokeObjectURL(a.url);
    listRef.current = [];
    setAttachments([]);
  };

  // A new host: upload every image there instead. An effect, since the
  // host is the caller's state and changes in its handlers.
  const firstTarget = useRef(true);
  useEffect(() => {
    if (firstTarget.current) {
      firstTarget.current = false;
      return;
    }
    const again = listRef.current.map((a) => ({ ...a, path: null, gen: a.gen + 1 }));
    listRef.current = again;
    setAttachments(again);
    again.forEach(start);
    // `start` reads refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  useMountEffect(() => () => listRef.current.forEach((a) => URL.revokeObjectURL(a.url)));

  /** The message with each uploaded image's path after the text, in the order added. */
  const withPaths = (text: string): string => {
    const paths = listRef.current.flatMap((a) => (a.path ? [a.path] : []));
    return [text.trimEnd(), ...paths].filter(Boolean).join(" ");
  };

  // A pasted image is attached rather than pasted. Pasted text (which a
  // file copied in Finder also carries, as its name) is left to the textarea.
  const pasteImage = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const data = e.clipboardData;
    if (Array.from(data.types).includes("text/plain")) return;
    const files = imageFiles(
      Array.from(data.items)
        .filter((item) => item.kind === "file")
        .flatMap((item) => item.getAsFile() ?? []),
    );
    if (files.length === 0) return;
    e.preventDefault();
    add(files);
  };

  // Dropped files are taken whatever they are, so a dropped PDF doesn't
  // navigate the window; only images are attached.
  const dropProps = {
    onDragOver: (e: DragEvent) => {
      if (!draggingFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    },
    onDrop: (e: DragEvent) => {
      if (!draggingFiles(e)) return;
      e.preventDefault();
      add(imageFiles(e.dataTransfer.files));
    },
  };

  const attachButton = (
    <>
      <Button
        type="button"
        variant="ghost"
        className={buttonClassName}
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
          add(files);
        }}
      />
    </>
  );

  return {
    attachments,
    /** True while an image is still uploading, so the message waits for its path. */
    uploading: attachments.some((a) => a.path === null),
    hasImages: attachments.length > 0,
    remove,
    clear,
    withPaths,
    pasteImage,
    dropProps,
    attachButton,
  };
}
