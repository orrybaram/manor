/**
 * Which link the pointer is over, for the terminal's context menu.
 *
 * xterm says nothing about links on a right-click; it only calls `hover` and
 * `leave` as the pointer crosses one. Every kind of link reports here: plain
 * URLs from `WebLinksAddon` and OSC 8 hyperlinks from `linkHandler`, whose
 * `text` is the target URL rather than what is printed, and file paths in the
 * workspace from the file link provider.
 */

/** A file of the terminal's workspace, as a path link names it. */
export type TerminalFileLink = {
  kind: "file";
  /** Workspace-relative, `/`-separated. */
  path: string;
  line?: number;
  col?: number;
};

export type TerminalLink = { kind: "url"; url: string } | TerminalFileLink;

export type LinkHoverTracker = {
  /** A URL link's `hover`. */
  hover: (_event: MouseEvent, text: string) => void;
  /** A file link's `hover`. */
  hoverFile: (link: TerminalFileLink) => void;
  leave: () => void;
  /** Forget the link: its terminal is going, and won't call `leave`. */
  clear: () => void;
  /** The link under the pointer, or null off every link. */
  current: () => TerminalLink | null;
};

export function createLinkHoverTracker(): LinkHoverTracker {
  let hovered: TerminalLink | null = null;
  const clear = () => {
    hovered = null;
  };
  return {
    hover: (_event, text) => {
      hovered = { kind: "url", url: text };
    },
    hoverFile: (link) => {
      hovered = link;
    },
    leave: clear,
    clear,
    current: () => hovered,
  };
}
