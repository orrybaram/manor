// Chapter II: the shell zoomed to the sidebar's workspaces beside Claude at work.
import "./chapter-2.css";
import { mountShell } from "../shell/shell";

const view = document.querySelector<HTMLElement>('[data-shell="rooms"]');
if (view) {
  mountShell(view, {
    label:
      "Manor's sidebar listing workspaces automations, bench-flood, go-to-file and homepage, each on its own branch, beside Claude building the homepage hero.",
    crop: { x: 0, y: 0, width: 922, height: 505 },
  });
}
