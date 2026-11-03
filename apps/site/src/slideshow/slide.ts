/**
 * What one slide of the hero slideshow is. The frame (slideshow.ts) knows only
 * this type, so a new feature is a new file in slides/ and a line in
 * slides/index.ts.
 */
import type { WindowData } from "../shell/chrome";

/** Every slide, in the order the tabs show them. Only those built get a tab. */
export const SLIDE_ORDER = [
  "side-by-side",
  "themes",
  "review",
  "pull-requests",
  "browser",
  "automations",
  "remote-hosts",
] as const;

export type SlideId = (typeof SLIDE_ORDER)[number];

/** How long a slide stays open while the slideshow plays. */
export const SLIDE_MS = 8000;

/** What the frame lends a slide for as long as it's the open one. */
export type SlideContext = {
  /** The window's root. Theme it with `applyTheme`; the frame puts the default back on the next entry. */
  root: HTMLElement;
  /** Redraw the whole window from `render`. A no-op until `enter` has returned; the frame draws right after. */
  render: () => void;
  /** Run `fn` after a delay (shortened under reduced motion), then redraw. Dropped if the slide is left first. */
  later: (ms: number, fn: () => void) => void;
  /** `later` without the redraw, for a slide changing its DOM in place: a redraw restarts every animation and transition in the window. */
  after: (ms: number, fn: () => void) => void;
  /** The window is at least partly on screen. */
  onScreen: () => boolean;
};

export type SlideFrame = {
  /** Time since the last frame. */
  ms: number;
  /** The slideshow's clock is running: not hovered, not focused, not stopped, at least a fifth on screen, the page's terminal shut. */
  advancing: boolean;
};

/** A slide once entered: the closures over its fresh state. */
export type OpenSlide = {
  /** The window as it stands now. For a slide that only owns the panel, `{ ...base, main }`. */
  render: () => WindowData;
  /** Called after each draw of `render`, the one chance to reach the new DOM. */
  drawn?: () => void;
  /** A click inside the window. The frame has already stopped autoplay. */
  onClick?: (e: MouseEvent) => void;
  /** A key pressed anywhere but the slideshow's own controls. Leave page keys alone; `preventDefault` a key you take, which stops autoplay as a click does. */
  onKey?: (e: KeyboardEvent) => void;
  /** Each animation frame while the window is on screen and the tab is showing. Never under reduced motion, even after Play: the slides advance, but nothing inside one moves by itself. */
  onFrame?: (frame: SlideFrame) => void;
};

export type Slide = {
  id: SlideId;
  /** The tab's text. */
  label: string;
  /** The caption's three parts: bold title, description, then "Try it: {hint}". */
  title: string;
  description: string;
  hint: string;
  /** What a screen reader hears for the window, which is drawn as one image. */
  alt: string;
  /** Called every time the slide opens; all its state starts here, so re-entering resets it. */
  enter: (ctx: SlideContext) => OpenSlide;
};
