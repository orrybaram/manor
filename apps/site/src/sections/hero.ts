// Hero: the facade, with the whole app window in a plain soft-shadowed frame.
import "./hero.css";
import { mountShell } from "../shell/shell";

const view = document.querySelector<HTMLElement>('[data-shell="hero"]');
if (view) {
  mountShell(view, {
    label:
      "An interactive mock of Manor: a sidebar of workspaces and agents, and four agent panes. Claude is working, Codex asks permission to run a test, opencode is thinking, and Claude reports passing tests.",
  });
}
