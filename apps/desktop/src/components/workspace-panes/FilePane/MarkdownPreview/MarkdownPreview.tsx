import { useMemo, useRef } from "react";
import { GfmMarkdown, jumpTo, type GfmImage } from "../../../ui/GfmMarkdown/GfmMarkdown";
import { useMountEffect } from "../../../../hooks/useMountEffect";
import { parseHttpsUrl } from "../../../../lib/http-url";
import { fenceFrontmatter, markdownLinkTarget } from "../markdown-preview";
import styles from "./MarkdownPreview.module.css";

type MarkdownPreviewProps = {
  source: string;
  /** The file as the pane holds it, which its relative links resolve against. */
  filePath: string;
  /** Asked once on mount: whether to take the keyboard, as an editor handed it would. */
  takeKeyboard: () => boolean;
  /** A relative link was followed. */
  onOpenFile: (path: string) => void;
};

function renderImage({ src, alt, width, height }: GfmImage) {
  return (
    <img
      src={src}
      alt={alt ?? ""}
      width={width}
      height={height}
      loading="lazy"
      referrerPolicy="no-referrer"
    />
  );
}

/** What can't be shown: `files.read` serves text only, and http is refused. The alt text stands in. */
function renderLocalImage({ alt, src }: GfmImage) {
  return (
    <span className={styles.localImage} title={src}>
      {alt || src}
    </span>
  );
}

/**
 * A markdown file rendered, in place of its editor. Focusable, so the pane's
 * keys (⌘S, ⌘B and the toggle back) still reach the pane while it shows.
 * Parsed only when the text changes; a reload from disk keeps the scroll.
 */
export function MarkdownPreview({ source, filePath, takeKeyboard, onOpenFile }: MarkdownPreviewProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const openFile = useRef(onOpenFile);
  openFile.current = onOpenFile;
  useMountEffect(() => {
    if (takeKeyboard()) rootRef.current?.focus({ preventScroll: true });
  });
  const body = useMemo(
    () => (
      <GfmMarkdown
        source={fenceFrontmatter(source)}
        localLink={(href) => {
          const target = markdownLinkTarget(filePath, href);
          if (target === null) return null;
          // This file, by name: nothing to open, only perhaps a place to go.
          const hash = href.slice(href.indexOf("#") + 1 || href.length);
          if (target === filePath && hash) {
            return () => {
              const body = rootRef.current?.firstElementChild;
              if (body) jumpTo(body, `#${hash}`);
            };
          }
          return () => openFile.current(target);
        }}
        renderLocalImage={renderLocalImage}
        renderImage={(image) =>
          // Opening a file from a repo shouldn't send plain-text requests anywhere.
          parseHttpsUrl(image.src) ? renderImage(image) : renderLocalImage(image)
        }
      />
    ),
    [source, filePath],
  );
  return (
    <div
      ref={rootRef}
      className={styles.preview}
      tabIndex={-1}
      data-testid="file-pane-markdown-preview"
    >
      <div className={styles.body}>{body}</div>
    </div>
  );
}
