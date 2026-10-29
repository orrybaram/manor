import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefCallback,
} from "react";
import { useMountEffect } from "../../../hooks/useMountEffect";
import {
  setToastStackHovered,
  useToasts,
  type ToastRecord,
} from "../../../toast";
import { ToastItem } from "./ToastItem";
import styles from "./Toast.module.css";

/** Cards that peek out behind the front one while the deck is collapsed. */
const PEEKING = 3;
/** Each card behind the front sits this much higher, and this much smaller. */
const PEEK_STEP_PX = 10;
const PEEK_SCALE_STEP = 0.05;
const PEEK_OPACITY = [1, 0.9, 0.75, 0.5];
/** Space between cards once the deck fans out. */
const FAN_GAP_PX = 8;
/** A card's content height before it has been measured: one line, no detail. */
const FALLBACK_HEIGHT_PX = 40;
/** The card's own top and bottom border, outside its measured content. */
const CARD_BORDER_PX = 2;

function cardKey(t: ToastRecord): string {
  return `${t.id}-${t.status}`;
}

interface Placement {
  style: CSSProperties;
  /** Whether it takes the pointer and keyboard: the front card, or any card fanned out. */
  interactive: boolean;
  /** Behind the front card in the collapsed deck: only its edge shows. */
  peeking: boolean;
}

/**
 * Where each card sits. The newest is in front; up to `PEEKING` older ones
 * peek out above it, smaller and fainter, cut to the front card's height so
 * the peeks line up; the rest wait out of sight behind. Fanned out, every
 * card stands at its own height in a column. A leaving card keeps the slot
 * it had, so the cards behind it move up while it fades.
 *
 * `extent` is the deck's height: its hit area, so it never covers more of
 * the app than the cards do.
 */
function placeCards(
  toasts: ToastRecord[],
  heights: Record<string, number>,
  fanned: boolean,
): { placements: Map<string, Placement>; extent: number } {
  const heightOf = (t: ToastRecord) =>
    heights[cardKey(t)] ?? FALLBACK_HEIGHT_PX;
  const newestFirst = [...toasts].reverse();
  const staying = newestFirst.filter((t) => !t.leaving);
  const front = staying[0] ?? newestFirst[0];
  const frontHeight = front ? heightOf(front) : FALLBACK_HEIGHT_PX;

  // Fanned: how far each staying card's foot sits above the deck's foot.
  const rises: number[] = [];
  let rise = 0;
  for (const t of staying) {
    rises.push(rise);
    rise += heightOf(t) + CARD_BORDER_PX + FAN_GAP_PX;
  }

  const placements = new Map<string, Placement>();
  let newerStaying = 0;
  for (const t of newestFirst) {
    // A leaving card holds the slot it had: just below every newer card still up.
    const index = newerStaying;
    if (!t.leaving) newerStaying++;
    const zIndex = 2 * (newestFirst.length - index) + (t.leaving ? 1 : 0);

    if (fanned) {
      placements.set(cardKey(t), {
        interactive: !t.leaving,
        peeking: false,
        style: {
          transform: `translateY(${-(rises[index] ?? rise)}px)`,
          height: heightOf(t),
          zIndex,
        },
      });
      continue;
    }

    const step = Math.min(index, PEEKING);
    placements.set(cardKey(t), {
      interactive: index === 0 && !t.leaving,
      peeking: index > 0,
      style: {
        transform: `translateY(${-PEEK_STEP_PX * step}px) scale(${1 - PEEK_SCALE_STEP * step})`,
        opacity: index > PEEKING ? 0 : PEEK_OPACITY[step],
        // The front card at its own height; the ones behind cut to match it.
        height: index === 0 ? heightOf(t) : frontHeight,
        zIndex,
      },
    });
  }

  const behind = Math.min(Math.max(staying.length - 1, 0), PEEKING);
  const extent = fanned
    ? Math.max(0, rise - FAN_GAP_PX)
    : frontHeight + CARD_BORDER_PX + PEEK_STEP_PX * behind;
  return { placements, extent };
}

/**
 * The toasts, as a deck in the bottom-right corner: collapsed to the newest
 * card with the next few peeking out behind it, fanned out into a column
 * while the pointer or keyboard focus is on it. Either one also holds every
 * countdown, so nothing leaves while you are reading it.
 */
export function ToastContainer() {
  const toasts = useToasts();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const stopWatchingRef = useRef<(() => void) | null>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const holdRef = useRef({ hovered: false, focused: false });
  const [heights, setHeights] = useState<Record<string, number>>({});
  const observerRef = useRef<ResizeObserver | null>(null);
  const measureRefs = useRef(new Map<string, RefCallback<HTMLDivElement>>());

  function hold(next: Partial<{ hovered: boolean; focused: boolean }>) {
    holdRef.current = { ...holdRef.current, ...next };
    setToastStackHovered(holdRef.current.hovered || holdRef.current.focused);
  }

  // `mouseleave` never fires when the toast under the pointer is removed, so
  // while hovered, any pointer arrival outside the stack also ends the hold.
  function stopHover() {
    stopWatchingRef.current?.();
    stopWatchingRef.current = null;
    setHovered(false);
    hold({ hovered: false });
  }

  function startHover() {
    setHovered(true);
    hold({ hovered: true });
    if (stopWatchingRef.current) return;
    const onPointerOver = (e: PointerEvent) => {
      const el = containerRef.current;
      if (!el || !(e.target instanceof Node) || !el.contains(e.target))
        stopHover();
    };
    document.addEventListener("pointerover", onPointerOver, true);
    stopWatchingRef.current = () =>
      document.removeEventListener("pointerover", onPointerOver, true);
  }

  function recordHeight(key: string, height: number) {
    setHeights((prev) =>
      prev[key] === height ? prev : { ...prev, [key]: height },
    );
  }

  function forgetHeight(key: string) {
    setHeights((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  function observer(): ResizeObserver {
    observerRef.current ??= new ResizeObserver((entries) => {
      for (const entry of entries) {
        const el = entry.target as HTMLElement;
        const key = el.dataset.toastKey;
        if (key) recordHeight(key, el.offsetHeight);
      }
    });
    return observerRef.current;
  }

  /**
   * A card's measuring ref, one per card for as long as it is up: measures its
   * content on mount (so it lands in place before paint) and on every resize
   * after — a detail expanding, a message updating.
   */
  function measureRef(key: string): RefCallback<HTMLDivElement> {
    let ref = measureRefs.current.get(key);
    if (ref) return ref;
    ref = (el) => {
      if (!el) return;
      el.dataset.toastKey = key;
      recordHeight(key, el.offsetHeight);
      const ro = observer();
      ro.observe(el);
      return () => {
        ro.unobserve(el);
        forgetHeight(key);
      };
    };
    measureRefs.current.set(key, ref);
    return ref;
  }

  useMountEffect(() => () => {
    stopHover();
    hold({ focused: false });
    observerRef.current?.disconnect();
  });

  // A focused card that a commit removes (its X pressed, a status change
  // remounting it) takes focus with it, and React delivers no blur. Re-check
  // after every change, and drop both holds once the deck empties, or the
  // countdowns stay held for good.
  useLayoutEffect(() => {
    if (toasts.length === 0 && holdRef.current.hovered) stopHover();
    if (!holdRef.current.focused) return;
    if (containerRef.current?.contains(document.activeElement)) return;
    setFocused(false);
    hold({ focused: false });
    // `stopHover` reads only refs and state setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toasts]);

  // Keep each card's ref for as long as the card is up: a new one each
  // render would detach and reattach it, and every reattach measures.
  const live = new Set(toasts.map(cardKey));
  for (const key of measureRefs.current.keys()) {
    if (!live.has(key)) measureRefs.current.delete(key);
  }

  if (toasts.length === 0) return null;

  const fanned = hovered || focused;
  const { placements, extent } = placeCards(toasts, heights, fanned);

  return (
    <div
      ref={containerRef}
      className={styles.container}
      style={{ height: extent }}
      role="region"
      aria-label="Notifications"
      data-testid="toast-deck"
      data-fanned={fanned ? "true" : "false"}
      onMouseEnter={startHover}
      onMouseLeave={stopHover}
      onFocus={(e) => {
        // Keyboard focus only: a click on a card's button focuses it too,
        // and that must not leave the deck fanned once the pointer leaves.
        if (
          !(e.target instanceof Element) ||
          !e.target.matches(":focus-visible")
        )
          return;
        setFocused(true);
        hold({ focused: true });
      }}
      onBlur={(e) => {
        const next = e.relatedTarget;
        if (next instanceof Node && e.currentTarget.contains(next)) return;
        setFocused(false);
        hold({ focused: false });
      }}
    >
      {toasts.map((t) => {
        const key = cardKey(t);
        const placement = placements.get(key)!;
        return (
          <div
            key={key}
            className={`${styles.card} ${t.leaving ? styles.exiting : ""} ${placement.interactive ? "" : styles.behind} ${placement.peeking ? styles.peeking : ""}`}
            style={placement.style}
            inert={!placement.interactive}
            data-testid="toast"
            data-status={t.status}
          >
            <ToastItem toast={t} measureRef={measureRef(key)} />
          </div>
        );
      })}
    </div>
  );
}
