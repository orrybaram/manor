// Side by side: four Agents in one tab, and Codex waiting on an answer.
import { onShellClick, onShellKey, type ShellContext } from "../../shell/interactions";
import { TICK_MS, tickAgents, windowData } from "../../shell/render";
import { createState } from "../../shell/state";
import type { Slide } from "../slide";

export const sideBySide: Slide = {
  id: "side-by-side",
  label: "Side by side",
  title: "Every agent in its own pane.",
  description: "Run any mix of agents side by side and see which one needs you.",
  hint: "Answer Codex's question.",
  alt: "An interactive mock of Manor: a sidebar of workspaces and agents, and four agent panes. Claude is working, Codex asks permission to run a test, opencode is thinking, and Claude reports passing tests.",
  enter(ctx) {
    const state = createState();
    const shell: ShellContext = { ...ctx, state };
    let sinceTick = 0;
    return {
      render: () => windowData(state),
      onClick: (e) => onShellClick(shell, e),
      onKey: (e) => onShellKey(shell, e),
      phoneCrop: () => ({ x: 716, y: 24 }),
      onFrame: ({ ms }) => {
        sinceTick += ms;
        if (sinceTick < TICK_MS) return;
        sinceTick %= TICK_MS;
        tickAgents(ctx.root, state);
      },
    };
  },
};
