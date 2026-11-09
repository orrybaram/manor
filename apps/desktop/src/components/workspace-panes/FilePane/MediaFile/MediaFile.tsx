import { useRef, useState } from "react";
import { useMountEffect } from "../../../../hooks/useMountEffect";
import type { FileMedia } from "../../../../lib/file-media";
import { ipcErrorMessage } from "../../../../lib/ipc-error";
import { useOpenFileStore } from "../../../../store/open-file-store";
import { sameWorkspace } from "../open-file-state";
import { openFileWatches, type FilesWorkspace } from "../open-file-watches";
import { pendingLines } from "../pending-line";
import { ImageView } from "./ImageView";
import type { OpenPdf } from "./pdf-document";
import { PdfView } from "./PdfView";
import paneStyles from "../FilePane.module.css";
import styles from "./MediaFile.module.css";

type Shown =
  | { kind: "image"; src: string }
  | { kind: "pdf"; pdf: OpenPdf }
  | {
      kind: "failed";
      message: string;
      /** Bytes that didn't parse: perhaps a file caught mid-write. */
      unparsed?: boolean;
    };

const failed = (message: string): Shown => ({ kind: "failed", message });

/** All of the file, a piece at a time (`FILE_BYTES_CHUNK`), or why it can't be read. */
async function readWholeFile(
  workspace: FilesWorkspace,
  path: string,
): Promise<{ base64: string } | { message: string }> {
  const pieces: string[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const piece = await window.electronAPI.files.readBytes(workspace, path, offset);
    if (!piece.ok) return { message: piece.message };
    pieces.push(piece.base64);
    offset = piece.next;
  }
  return { base64: pieces.join("") };
}

/** Why a PDF could not be opened, as the pane says it. */
function pdfFailure(err: unknown, path: string): string {
  const name = (err as { name?: unknown } | null)?.name;
  return name === "PasswordException"
    ? `${path} is password-protected`
    : `${path} is not a readable PDF`;
}

/** The file as it is on disk now, ready to show, or why it can't be. */
async function loadMedia(workspace: FilesWorkspace, path: string, media: FileMedia): Promise<Shown> {
  let base64: string;
  try {
    const result = await readWholeFile(workspace, path);
    if ("message" in result) return failed(result.message);
    base64 = result.base64;
  } catch (err) {
    return failed(ipcErrorMessage(err));
  }
  if (media.kind === "image") {
    return { kind: "image", src: `data:${media.mimeType};base64,${base64}` };
  }
  try {
    const { openPdf } = await import("./pdf-document");
    return { kind: "pdf", pdf: await openPdf(base64) };
  } catch (err) {
    return { kind: "failed", message: pdfFailure(err, path), unparsed: true };
  }
}

/**
 * An image or a PDF: read it, show it, and read it again when it changes on
 * disk. Mounted keyed by the file. It has nothing to edit, so `open-file-store`
 * only hears that the pane moved on: what it held was for another file.
 */
export function MediaFile({
  paneId,
  workspace,
  path,
  media,
}: {
  paneId: string;
  workspace: FilesWorkspace;
  path: string;
  media: FileMedia;
}) {
  const [shown, setShown] = useState<Shown | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);

  useMountEffect(() => {
    let live = true;
    let openDoc: OpenPdf["doc"] | null = null;
    // A file rewritten faster than it reads is read once more when the read
    // in flight lands, not once per change.
    let reading = false;
    let readAgain = false;

    useOpenFileStore.getState().open(paneId, workspace, path);

    const read = async () => {
      if (reading) {
        readAgain = true;
        return;
      }
      reading = true;
      do {
        readAgain = false;
        const next = await loadMedia(workspace, path, media);
        const doc = next.kind === "pdf" ? next.pdf.doc : null;
        if (!live) {
          void doc?.loadingTask.destroy();
          return;
        }
        // A build rewrites its PDF in place, and a poll can land halfway: the
        // pages shown stay, with their zoom and scroll, until it reads whole.
        if (next.kind === "failed" && next.unparsed && openDoc) continue;
        void openDoc?.loadingTask.destroy();
        openDoc = doc;
        setShown(next);
      } while (readAgain);
      reading = false;
    };

    // Sent from elsewhere (a terminal link, Go to File), it takes the keyboard
    // as the editor would, so the arrow keys scroll it. There is no line to go to.
    const takeKeyboard = () => {
      if (pendingLines.take(paneId, path)) scrollerRef.current?.focus({ preventScroll: true });
    };
    takeKeyboard();
    const stopLines = pendingLines.subscribe(paneId, takeKeyboard);

    const stopListening = window.electronAPI.files.onChanged((event) => {
      if (event.path === path && sameWorkspace(event.workspace, workspace)) void read();
    });
    // Read first, then watch: a change between the two is not reported.
    void read().then(() => {
      if (live) openFileWatches.set(workspace, paneId, path);
    });

    return () => {
      live = false;
      stopLines();
      stopListening();
      openFileWatches.set(workspace, paneId, null);
      void openDoc?.loadingTask.destroy();
    };
  });

  if (shown?.kind === "failed") {
    return (
      <div className={paneStyles.empty} data-testid="file-pane-error">
        {shown.message}
      </div>
    );
  }
  return (
    // What sits in its corners is placed against the frame, so it stays put
    // while the scroller inside moves.
    <div className={styles.frame}>
      <div
        ref={scrollerRef}
        className={`${styles.scroller} ${shown?.kind === "image" ? styles.imageScroller : ""}`}
        data-testid="file-pane-media"
        // The keyboard scrolls it.
        tabIndex={0}
      >
        {shown?.kind === "image" && (
          <ImageView
            src={shown.src}
            path={path}
            onFail={() => setShown(failed(`${path} can't be shown as an image`))}
          />
        )}
        {shown?.kind === "pdf" && <PdfView pdf={shown.pdf} scrollerRef={scrollerRef} />}
      </div>
    </div>
  );
}
