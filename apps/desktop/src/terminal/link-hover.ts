/**
 * Which link the pointer is over, for the terminal's context menu.
 *
 * xterm says nothing about links on a right-click; it only calls `hover` and
 * `leave` as the pointer crosses one. Both kinds of link report here: plain
 * URLs from `WebLinksAddon` and OSC 8 hyperlinks from `linkHandler`, whose
 * `text` is the target URL rather than what is printed.
 */
export type LinkHoverTracker = {
  hover: (_event: MouseEvent, text: string) => void;
  leave: () => void;
  /** Forget the link: its terminal is going, and won't call `leave`. */
  clear: () => void;
  /** The URL under the pointer, or null off every link. */
  current: () => string | null;
};

export function createLinkHoverTracker(): LinkHoverTracker {
  let hovered: string | null = null;
  const clear = () => {
    hovered = null;
  };
  return {
    hover: (_event, text) => {
      hovered = text;
    },
    leave: clear,
    clear,
    current: () => hovered,
  };
}
