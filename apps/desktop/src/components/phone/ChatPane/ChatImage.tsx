import { useContext, useState } from "react";
import { useMountEffect } from "../../../hooks/useMountEffect";
import { fileMedia } from "../../../lib/file-media";
import { ChatHostContext } from "./chat-host-context";
import styles from "./ChatPane.module.css";

/** The image's bytes as a data URL, or null when they can't be read. */
async function readImage(hostId: string, path: string): Promise<string | null> {
  const media = fileMedia(path);
  if (media?.kind !== "image") return null;
  const pieces: string[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    // An absolute path is read from the host's root, as the file pane reads
    // a file outside its workspace.
    const piece = await window.electronAPI.files.readBytes(
      { path: "/", hostId },
      path.replace(/^\/+/, ""),
      offset,
    );
    if (!piece.ok) return null;
    pieces.push(piece.base64);
    offset = piece.next;
  }
  return `data:${media.mimeType};base64,${pieces.join("")}`;
}

/**
 * An image pasted into a prompt, shown in its bubble in place of the path it
 * reached the agent as. Read from the pane's host; a chip with the file's
 * name when it can't be (pasted images are swept after a week). A click
 * toggles it between thumbnail and the bubble's full width.
 */
export function ChatImage({ path }: { path: string }) {
  const hostId = useContext(ChatHostContext);
  const [src, setSrc] = useState<string | null | undefined>(
    hostId ? undefined : null,
  );
  const [large, setLarge] = useState(false);
  const name = path.slice(path.lastIndexOf("/") + 1);

  useMountEffect(() => {
    if (!hostId) return;
    let live = true;
    readImage(hostId, path)
      .catch(() => null)
      .then((next) => {
        if (live) setSrc(next);
      });
    return () => {
      live = false;
    };
  });

  if (src === null) {
    return (
      <span className={styles.imageChip} title={path} data-testid="chat-image">
        Image · {name}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={styles.imageThumb}
      data-large={large || undefined}
      title={path}
      aria-label={`Pasted image ${name}`}
      aria-expanded={large}
      data-testid="chat-image"
      onClick={() => setLarge((l) => !l)}
    >
      {src && <img src={src} alt="" />}
    </button>
  );
}
