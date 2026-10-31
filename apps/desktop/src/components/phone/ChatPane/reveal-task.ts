import styles from "./ChatPane.module.css";

/**
 * Scroll the task card with `id` under `root` into view, and flash it so the
 * eye finds it. Nothing happens if the card isn't mounted.
 */
export function revealTaskCard(
  root: ParentNode | null | undefined,
  id: string,
  options: { smooth?: boolean } = {},
): void {
  const cards = root?.querySelectorAll<HTMLElement>("[data-task-id]") ?? [];
  const card = [...cards].find((el) => el.dataset.taskId === id);
  if (!card) return;
  card.scrollIntoView({ block: "center", behavior: options.smooth === false ? "auto" : "smooth" });
  card.classList.remove(styles.taskFlash);
  // Reflow, so picking the same card twice flashes it again.
  void card.offsetWidth;
  card.classList.add(styles.taskFlash);
  card.addEventListener("animationend", () => card.classList.remove(styles.taskFlash), {
    once: true,
  });
}
