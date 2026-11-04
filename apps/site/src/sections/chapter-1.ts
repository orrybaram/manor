// Chapter I: the shell zoomed to Codex's pane, waiting on a yes.
import "./chapter-1.css";
import { mountShell } from "../shell/shell";

const view = document.querySelector<HTMLElement>('[data-shell="ask"]');
if (view) {
  mountShell(view, {
    label: "A Codex pane in Manor asking: Allow command? pnpm vitest run FileTree, with Yes, Always and No options.",
    crop: { x: 753, y: 50, width: 519, height: 356 },
    focus: "gtf",
  });
}
