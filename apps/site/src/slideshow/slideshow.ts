/**
 * The hero's slideshow: one window, a row of tabs above it, a caption and a
 * Pause/Play button below it, after the W3C tabs and carousel patterns.
 *
 * Autoplay has two layers. `playing` is whether it's meant to run at all (the
 * visitor's Pause, Play and clicks, and reduced motion); `advancing()` adds
 * the moment-to-moment conditions on top (a fifth on screen, tab showing, nobody
 * hovering or focused inside, the page's terminal shut).
 */
import "./slideshow.css";
import { renderWindow } from "../shell/chrome";
import { mountWindow } from "../shell/shell";
import { DEFAULT_THEME, applyTheme } from "../shell/tokens";
import { SLIDE_MS, type OpenSlide, type Slide, type SlideContext } from "./slide";

const FADE_MS = 200;
/** A frame longer than this is the browser having been busy, not time on the slide. */
const MAX_FRAME_MS = 100;
/** How much of the window must show for it to count as watched. At 1440×900 the hero shows 27% on load. */
const WATCHED_RATIO = 0.2;

const PAUSE_ICON = '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M2.5 1.5H5v9H2.5zM7 1.5h2.5v9H7z"/></svg>';
const PLAY_ICON = '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M3 1.3 10.5 6 3 10.7z"/></svg>';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

/** Fills `container`, which already holds the frame (`.shot`) and its `.mapp-view`, with the tabs and caption. */
export function mountSlideshow(container: HTMLElement, slides: readonly Slide[]): void {
  const frame = container.querySelector<HTMLElement>(".shot");
  const view = container.querySelector<HTMLElement>(".mapp-view");
  const first = slides[0];
  if (!frame || !view || !first) return;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  // Kept from the event, not read each frame: Chromium swallows the change event if `.matches` reads the new value first.
  let motionReduced = reduced.matches;

  const tablist = el("div", "slideshow-tabs");
  tablist.setAttribute("role", "tablist");
  tablist.setAttribute("aria-label", "Manor features");
  const tabs = slides.map((slide) => {
    const tab = el("button", "slideshow-tab");
    tab.type = "button";
    tab.id = `slide-tab-${slide.id}`;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", "slide-panel");
    tab.textContent = slide.label;
    tab.append(el("span", "slideshow-progress"));
    tablist.append(tab);
    return tab;
  });

  const caption = el("div", "slideshow-caption");
  const text = el("div", "slideshow-text");
  text.setAttribute("aria-atomic", "true");
  const toggle = el("button", "slideshow-toggle");
  toggle.type = "button";
  caption.append(text, toggle);

  container.prepend(tablist);
  container.append(caption);
  view.id = "slide-panel";
  view.setAttribute("role", "tabpanel");
  view.tabIndex = 0;

  const root = mountWindow(view, { label: first.alt });

  let index = 0;
  let open: OpenSlide;
  let elapsed = 0;
  /** Bumped on each entry, so what the last slide left running goes quiet. */
  let entry = 0;

  let playing = !motionReduced;
  let stoppedByVisitor = false;
  let inView = false;
  let watched = false;
  let hovering = false;
  let keyboardInside = false;
  /** Play was pressed with the keyboard on it: that focus shouldn't hold back what it just asked for. */
  let playedFromFocus = false;

  /** A dialog of the page's own, the ⌘K terminal: slides shouldn't change behind it. */
  const pageDialogOpen = () => document.querySelector('[aria-modal="true"]:not([hidden])') !== null;

  const advancing = () =>
    playing && watched && !document.hidden && !hovering && (!keyboardInside || playedFromFocus) && !pageDialogOpen();

  const setProgress = () => tablist.style.setProperty("--slide-progress", String(elapsed / SLIDE_MS));

  const enter = (next: number, fade: boolean) => {
    const slide = slides[next]!;
    const current = ++entry;
    index = next;
    elapsed = 0;
    setProgress();
    applyTheme(root, DEFAULT_THEME);
    // Nothing to draw until `slide.enter` has returned: a slide asking early gets a no-op.
    let entered: OpenSlide | null = null;
    const render = () => {
      if (current !== entry || !entered) return;
      root.innerHTML = renderWindow(entered.render());
      entered.drawn?.();
    };
    const hold = (ms: number, fn: () => void) =>
      void setTimeout(() => {
        if (current === entry) fn();
      }, ms);
    const after = (ms: number, fn: () => void) => hold(motionReduced ? Math.min(ms, 300) : ms, fn);
    const ctx: SlideContext = {
      root,
      render,
      after,
      hold,
      later: (ms, fn) =>
        after(ms, () => {
          fn();
          render();
        }),
      onScreen: () => inView,
    };
    entered = slide.enter(ctx);
    open = entered;
    render();

    root.setAttribute("aria-label", slide.alt);
    view.setAttribute("aria-labelledby", tabs[next]!.id);
    tabs.forEach((tab, i) => {
      tab.setAttribute("aria-selected", String(i === next));
      tab.tabIndex = i === next ? 0 : -1;
    });
    const title = el("b", "");
    title.textContent = slide.title;
    const hint = el("span", "slideshow-hint");
    hint.textContent = `Try it: ${slide.hint}`;
    text.replaceChildren(title, ` ${slide.description}`, hint);

    if (fade) {
      // Scrolls only the row: a slide changing by itself must never move the page.
      const tab = tabs[next]!;
      tablist.scrollTo({
        left: tab.offsetLeft - (tablist.clientWidth - tab.offsetWidth) / 2,
        behavior: motionReduced ? "auto" : "smooth",
      });
      if (!motionReduced) root.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS, easing: "ease-out" });
    }
  };

  // Entering the open slide again would wipe what the visitor did in it.
  const select = (next: number) => {
    if (next !== index) enter(next, true);
  };

  const showPlaying = () => {
    toggle.innerHTML = playing ? `${PAUSE_ICON}Pause` : `${PLAY_ICON}Play`;
    toggle.setAttribute("aria-label", playing ? "Pause automatic slideshow" : "Play automatic slideshow");
    text.setAttribute("aria-live", playing ? "off" : "polite");
  };

  let raf = 0;
  let lastFrame = 0;
  const onAnimationFrame = (now: number) => {
    raf = requestAnimationFrame(onAnimationFrame);
    const ms = Math.max(0, Math.min(now - lastFrame, MAX_FRAME_MS));
    lastFrame = now;
    const moving = advancing();
    // Reduced motion with Play pressed: the slides still advance, but nothing in them moves by itself.
    if (!motionReduced) open.onFrame?.({ ms, advancing: moving });
    if (!moving) return;
    elapsed += ms;
    if (elapsed < SLIDE_MS) {
      setProgress();
    } else if (slides.length > 1) {
      enter((index + 1) % slides.length, true);
    } else {
      elapsed = 0; // Nothing to move to: the line runs again and the slide keeps its state.
      setProgress();
    }
  };

  /** Run frames only when something would use them. */
  const sync = () => {
    const run = inView && !document.hidden && (!motionReduced || playing);
    if (run && !raf) {
      lastFrame = performance.now();
      raf = requestAnimationFrame(onAnimationFrame);
    } else if (!run && raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  };

  const setPlaying = (next: boolean) => {
    playing = next;
    showPlaying();
    sync();
  };

  const stop = () => {
    stoppedByVisitor = true;
    setPlaying(false);
  };

  // ---- controls ------------------------------------------------------------

  tabs.forEach((tab, i) =>
    tab.addEventListener("click", () => {
      stop();
      select(i);
    }),
  );

  // Left/Right, Home and End, as the tabs pattern has them for a horizontal row. Up and Down keep scrolling the page.
  tablist.addEventListener("keydown", (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const n = slides.length;
    const next = { ArrowRight: (index + 1) % n, ArrowLeft: (index - 1 + n) % n, Home: 0, End: n - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    stop();
    select(next);
    tabs[next]!.focus({ preventScroll: true });
  });

  toggle.addEventListener("click", () => {
    if (playing) {
      stop();
      return;
    }
    stoppedByVisitor = false;
    playedFromFocus = keyboardInside;
    setPlaying(true);
  });

  root.addEventListener("click", (e) => {
    stop();
    open.onClick?.(e);
  });

  // The slideshow's own controls keep their keys, whatever the slide was typing into.
  document.addEventListener("keydown", (e) => {
    const target = e.target as Node | null;
    if (tablist.contains(target) || toggle.contains(target)) return;
    // A key the slide took is the visitor trying something, as a click is. Before and after, since the page's own handlers may have prevented it already.
    const taken = e.defaultPrevented;
    open.onKey?.(e);
    if (!taken && e.defaultPrevented) stop();
  });

  // ---- what pauses it -------------------------------------------------------

  container.addEventListener("pointerenter", (e) => {
    if (e.pointerType === "touch") return;
    hovering = true;
    sync();
  });
  container.addEventListener("pointerleave", () => {
    hovering = false;
    sync();
  });

  // Keyboard focus only: a mouse click leaves focus on Play, which mustn't hold it paused.
  const onFocusChange = () => {
    const active = document.activeElement;
    keyboardInside = !!active && container.contains(active) && active.matches(":focus-visible");
    playedFromFocus = false;
    sync();
  };
  container.addEventListener("focusin", onFocusChange);
  container.addEventListener("focusout", onFocusChange);

  new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        inView = e.isIntersecting;
        watched = e.isIntersecting && e.intersectionRatio >= WATCHED_RATIO;
      }
      sync();
    },
    { threshold: [0, WATCHED_RATIO] },
  ).observe(frame);
  document.addEventListener("visibilitychange", sync);
  reduced.addEventListener("change", (e) => {
    motionReduced = e.matches;
    setPlaying(!motionReduced && !stoppedByVisitor);
  });

  enter(0, false);
  showPlaying();
}
