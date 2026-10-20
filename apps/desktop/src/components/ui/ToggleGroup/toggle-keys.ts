/**
 * Keyboard handling for `ToggleGroup`, a radio group (WAI-ARIA radio group
 * pattern). DOM-free so it can be tested without rendering.
 */

const STEP_KEYS: Record<string, 1 | -1> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
};

/**
 * What `key` does in a group whose choosable options are `enabled`, when
 * focus is on `from`. It returns the option to focus, and whether to choose
 * it too, or null when the key isn't a navigation key. Arrow keys wrap;
 * Home and End go to the ends. In `automatic` mode moving also chooses; in
 * `manual` mode it only focuses, and Enter or Space (the button's own click)
 * chooses.
 */
export function toggleKeyAction<T>(
  key: string,
  enabled: readonly T[],
  from: T | undefined,
  activationMode: "automatic" | "manual",
): { focus: T; choose: boolean } | null {
  if (enabled.length === 0) return null;
  const at = Math.max(0, from === undefined ? 0 : enabled.indexOf(from));
  let target: number;
  if (key === "Home") target = 0;
  else if (key === "End") target = enabled.length - 1;
  else if (key in STEP_KEYS) target = (at + STEP_KEYS[key] + enabled.length) % enabled.length;
  else return null;
  return { focus: enabled[target], choose: activationMode === "automatic" };
}
