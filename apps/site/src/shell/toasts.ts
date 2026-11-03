/**
 * components/ui/Toast: the deck in the corner, newest in front with older cards
 * peeking out above it. Cards change in place, so a window redraw neither
 * replays one's entrance nor stops another's leaving. Hovering the app's deck
 * fans it out and holds its countdowns; this one doesn't.
 */
import { esc } from "./chrome";
import { icon } from "./icons";

const AUTO_DISMISS_MS = 3000;
const EXIT_MS = 200;
const PEEKING = 3;
const PEEK_STEP_PX = 10;
const PEEK_SCALE_STEP = 0.05;
const PEEK_OPACITY = [1, 0.9, 0.75, 0.5];
/** One line of text in the card's padding, until measured. */
const FALLBACK_HEIGHT_PX = 34;

type Toast = { id: number; message: string; leaving: boolean; height: number };

export type ToastDeck = {
  /** Show a success toast (the only kind a slide needs), for the app's 3s. Call it after the window's drawn. */
  show: (message: string) => void;
  /** For `WindowData.overlay`. */
  html: () => string;
};

export function createToasts(root: HTMLElement, after: (ms: number, fn: () => void) => void): ToastDeck {
  let toasts: Toast[] = [];
  let nextId = 0;

  /** Toast.tsx `placeCards`, collapsed. */
  const place = (el: HTMLElement, toast: Toast) => {
    const newestFirst = [...toasts].reverse();
    const staying = newestFirst.filter((t) => !t.leaving);
    const front = staying[0] ?? newestFirst[0]!;
    const before = newestFirst.indexOf(toast);
    const index = newestFirst.slice(0, before).filter((t) => !t.leaving).length;
    const step = Math.min(index, PEEKING);
    el.classList.toggle("ma-toast-peeking", index > 0);
    el.classList.toggle("ma-toast-out", toast.leaving);
    el.style.transform = `translateY(${-PEEK_STEP_PX * step}px) scale(${1 - PEEK_SCALE_STEP * step})`;
    el.style.opacity = String(index > PEEKING ? 0 : PEEK_OPACITY[step]);
    el.style.height = `${index === 0 ? toast.height : front.height}px`;
    el.style.zIndex = String(2 * (newestFirst.length - index) + (toast.leaving ? 1 : 0));
  };

  const card = (toast: Toast) => {
    const el = document.createElement("div");
    el.className = "ma-toast";
    el.dataset.toast = String(toast.id);
    el.innerHTML = `<div class="ma-toast-body"><span class="ma-toast-icon">${icon("circle-check", 14)}</span><div class="ma-toast-message">${esc(toast.message)}</div></div>`;
    return el;
  };

  const sync = () => {
    const deck = root.querySelector<HTMLElement>(".ma-toasts");
    if (!deck) return;
    for (const el of deck.querySelectorAll<HTMLElement>("[data-toast]")) {
      if (!toasts.some((t) => String(t.id) === el.dataset.toast)) el.remove();
    }
    for (const toast of toasts) {
      let el = deck.querySelector<HTMLElement>(`[data-toast="${toast.id}"]`);
      if (!el) {
        el = card(toast);
        el.classList.add("ma-toast-in");
        deck.append(el);
        toast.height = el.querySelector<HTMLElement>(".ma-toast-body")!.offsetHeight;
      }
      place(el, toast);
    }
  };

  return {
    show: (message) => {
      const toast: Toast = { id: nextId++, message, leaving: false, height: FALLBACK_HEIGHT_PX };
      toasts.push(toast);
      sync();
      after(AUTO_DISMISS_MS, () => {
        toast.leaving = true;
        sync();
        after(EXIT_MS, () => {
          toasts = toasts.filter((t) => t !== toast);
          sync();
        });
      });
    },
    html: () => {
      const deck = document.createElement("div");
      for (const toast of toasts) {
        const el = card(toast);
        place(el, toast);
        deck.append(el);
      }
      return `<div class="ma-toasts" role="status" aria-label="Notifications">${deck.innerHTML}</div>`;
    },
  };
}
