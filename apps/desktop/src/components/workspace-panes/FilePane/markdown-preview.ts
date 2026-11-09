import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import { isOutsideWorkspace, tidyAbsolute } from "../../../lib/file-location";
import { createStoredFlag } from "../../../lib/stored-flag";
import { normalizeAbsolute } from "../../../terminal/file-path-links";
import { languageFor } from "./file-languages";
import { pendingLines } from "./pending-line";

/**
 * Whether markdown files show rendered: off until you turn it on, and then
 * kept across files and relaunches, so reading a run of them takes one toggle.
 */
const previewPref = createStoredFlag("manor:markdownPreview");

export function isMarkdownFile(path: string): boolean {
  return languageFor(path) === "markdown";
}

/**
 * What the editor needs of its view before it acts: to be seen, because it is
 * about to move its cursor or open Find, or just the keyboard for the file.
 */
export type EditorAsk = "place" | "keyboard";

/**
 * Whether the open file shows rendered. A diff is the editor's, and so is
 * whatever asks for a place in the source: a line, Find or a change jump shows
 * the source, without changing the remembered choice.
 */
export function useMarkdownPreview({
  paneId,
  path,
  hasDiff,
  focusFile,
}: {
  paneId: string;
  path: string;
  hasDiff: boolean;
  /** Hand the keyboard to whichever of the editor and the preview shows. */
  focusFile: () => void;
}) {
  const canPreview = isMarkdownFile(path) && !hasDiff;
  const pref = previewPref.store((s) => s.on);
  const [waiting] = useState(() => {
    const request = pendingLines.waiting(paneId);
    return request?.path === path ? request : null;
  });
  const [sourceAsked, setSourceAsked] = useState(waiting?.line !== undefined);
  const previewing = canPreview && pref && !sourceAsked;
  const previewingNow = useRef(previewing);
  previewingNow.current = previewing;
  // The preview's next mount takes the keyboard when it was asked for: opened
  // from elsewhere, or toggled on. Its chunk may still be loading then. Not
  // when another pane's toggle brings it up.
  const wantsKeyboard = useRef(waiting !== null && waiting.line === undefined);
  // Off, there is no preview to take it. Leaving a diff, the preview replaces
  // whatever had it, so nothing would be left holding it.
  if (!pref) wantsKeyboard.current = false;
  else if (hasDiff) wantsKeyboard.current = true;

  // Stable, as the editor reads it once. Flushed: the editor acts right after,
  // and focus can't land in what is still hidden.
  const [onEditorAsk] = useState(() => (ask: EditorAsk) => {
    if (ask === "place") {
      // Asked even while a diff shows: the line has to outlive the diff closing.
      wantsKeyboard.current = false;
      if (isMarkdownFile(path)) flushSync(() => setSourceAsked(true));
    } else if (previewingNow.current) {
      focusFile();
    }
  });

  const togglePreview = () => {
    wantsKeyboard.current = !previewing;
    flushSync(() => {
      setSourceAsked(false);
      previewPref.set(!previewing);
    });
    if (previewing) focusFile();
  };

  const takeKeyboard = () => {
    const wanted = wantsKeyboard.current;
    wantsKeyboard.current = false;
    return wanted;
  };

  return { canPreview, previewing, togglePreview, takeKeyboard, onEditorAsk };
}

const FRONTMATTER = /^---\r?\n(?:---|([\s\S]*?)\r?\n---)[ \t]*(?:\r?\n|$)/;
/** A block opens with a key or a comment; a rule opening a document has prose after it. */
const YAML_START = /^(?:#|[\w"'.-]+[ \t]*:)/;

/**
 * `source` with its YAML frontmatter as a code block. Left alone, markdown
 * reads it as a rule and a heading made of the whole block.
 */
export function fenceFrontmatter(source: string): string {
  const match = FRONTMATTER.exec(source);
  if (!match) return source;
  const [block, yaml] = match;
  if (yaml === undefined) return source.slice(block.length);
  if (!YAML_START.test(yaml)) return source;
  return `\`\`\`\`yaml\n${yaml}\n\`\`\`\`\n\n${source.slice(block.length)}`;
}

/**
 * The file a link in the markdown file `filePath` points at, as a pane holds
 * it (see `file-location`): relative to the workspace, or absolute for a file
 * outside it. Null for a URL with a scheme, a bare `#anchor`, a folder (a pane
 * opens files), or a path that climbs out of the workspace.
 */
export function markdownLinkTarget(filePath: string, href: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) return null;
  const bare = href.split(/[?#]/, 1)[0];
  if (!bare) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(bare);
  } catch {
    return null;
  }
  // A leading `/` starts from the root the file is read from.
  if (decoded.endsWith("/")) return null;
  const folder = filePath.split("/").slice(0, -1).join("/");
  const absolute = decoded.startsWith("/") ? decoded : `/${folder}/${decoded}`;
  if (isOutsideWorkspace(filePath)) {
    const target = tidyAbsolute(absolute);
    return target === "/" ? null : target;
  }
  return normalizeAbsolute(absolute)?.slice(1) || null;
}
