import { useAutoAnimate } from "@formkit/auto-animate/react";

/** One easing for the whole dashboard, so every list moves the same way. */
const OPTIONS = { duration: 220, easing: "cubic-bezier(0.2, 0.7, 0.2, 1)" };

/**
 * A ref for a container whose children should animate in, out and between
 * positions: a card snoozed, a PR moving stage, a lane reordering. The
 * library skips animation under `prefers-reduced-motion`.
 */
export function useDashboardAnimate<T extends Element = HTMLDivElement>() {
  const [ref] = useAutoAnimate<T>(OPTIONS);
  return ref;
}
