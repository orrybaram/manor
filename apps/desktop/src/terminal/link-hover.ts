/**
 * Which link the pointer is over, for the terminal's context menu.
 *
 * xterm says nothing about links on a right-click; it only calls `hover` and
 * `leave` as the pointer crosses one. Both kinds of link report here: plain
 * URLs from `WebLinksAddon` and OSC 8 hyperlinks from `linkHandler`, whose
 * `text` is the target URL rather than what is printed.
 *
 * Moving straight from one link to the next can call the new link's `hover`
 * before the old one's `leave`, so a `leave` only clears the link it names.
 */
export type LinkHoverTracker = {
  hover: (_event: MouseEvent, text: string) => void;
  leave: (_event: MouseEvent, text: string) => void;
  /** The URL under the pointer, or null off every link. */
  current: () => string | null;
};

export function createLinkHoverTracker(): LinkHoverTracker {
  let hovered: string | null = null;
  return {
    hover: (_event, text) => {
      hovered = text;
    },
    leave: (_event, text) => {
      if (hovered === text) hovered = null;
    },
    current: () => hovered,
  };
}
