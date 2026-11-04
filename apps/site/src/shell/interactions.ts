/**
 * What the shell does when poked: Codex's Yes/Always/No, switching workspaces
 * and agents, focusing panes, and typing into "Automations suite".
 */
import { esc } from "./chrome";
import { renderPanes } from "./render";
import { isAgentId, selectWorkspace, setAgentStatus, type ShellState } from "./state";

export type ShellContext = {
  root: HTMLElement;
  state: ShellState;
  render: () => void;
  /** Run `fn` after a delay (shortened under reduced motion), then redraw. */
  later: (ms: number, fn: () => void) => void;
  /** This mount is at least partly on screen. */
  onScreen: () => boolean;
};

/**
 * The one mount the keyboard types into: whichever had its visible
 * "Automations suite" pane clicked last. Any click elsewhere hands the keys
 * back to the page, so Space scrolls and other mounts never echo the text.
 */
let typingInto: ShellContext | null = null;

document.addEventListener(
  "pointerdown",
  (e) => {
    const pane = (e.target as Element | null)?.closest('[data-pane="suite"]');
    if (!pane) typingInto = null;
  },
  { capture: true },
);

export function onShellClick(ctx: ShellContext, e: MouseEvent): void {
  const { state } = ctx;
  const t = (e.target as Element | null)?.closest<HTMLElement>("[data-act],[data-ws],[data-agent],[data-pane]");
  if (!t || !ctx.root.contains(t)) return;
  const { act, ws, agent, pane } = t.dataset;
  typingInto = pane === "suite" ? ctx : null;

  if (act) {
    const a = state.agents.gtf;
    if (act === "no") {
      setAgentStatus(state, "gtf", "responded");
      a.log = ['<span class="b">•</span> Skipped <b>pnpm vitest run FileTree</b>. What should I do instead?', ""];
    } else {
      setAgentStatus(state, "gtf", "working");
      a.log = ['<span class="b">•</span> Ran <b>pnpm vitest run FileTree</b>', '  <span class="d">└ running…</span>'];
      ctx.later(1800, () => {
        setAgentStatus(state, "gtf", "responded");
        a.log = [
          '<span class="b">•</span> Ran <b>pnpm vitest run FileTree</b>',
          '  <span class="d">└</span> <span class="g">✓ 18 passed (1.2s)</span>',
          "",
          '<span class="b">•</span> Go to File now opens from the drawer, with a test.',
          "",
        ];
      });
    }
    ctx.render();
    return;
  }
  if (ws) {
    selectWorkspace(state, ws);
    ctx.render();
    return;
  }
  if (isAgentId(state, agent)) {
    selectWorkspace(state, state.agents[agent].ws, agent);
    ctx.render();
    return;
  }
  if (isAgentId(state, pane) && state.focus !== pane) {
    state.focus = pane;
    ctx.render();
  }
}

/** Something else on the page has the keyboard: a field, or an open dialog. */
function keyboardTaken(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return true;
  return document.querySelector('[aria-modal="true"]:not([hidden])') !== null;
}

/** Keys go to "Automations suite" once its pane was clicked, while it stays open and on screen. Enter sends a canned turn. */
export function onShellKey(ctx: ShellContext, e: KeyboardEvent): void {
  const { state } = ctx;
  if (typingInto !== ctx || state.focus !== "suite" || state.ws !== "homepage" || e.metaKey || e.ctrlKey || e.altKey) return;
  if (keyboardTaken(e) || !ctx.onScreen()) return;
  const a = state.agents.suite;
  if (e.key === "Enter" && state.typing.trim()) {
    const said = state.typing;
    state.typing = "";
    a.log.push(`<span class="d">&gt;</span> ${esc(said)}`, "");
    setAgentStatus(state, "suite", "thinking");
    ctx.render();
    ctx.later(900, () => {
      setAgentStatus(state, "suite", "working");
    });
    ctx.later(2400, () => {
      setAgentStatus(state, "suite", "responded");
      a.log.push(
        '<span class="g">●</span> On it. That would land in its own worktree, so',
        "  nothing else in the house is touched.",
        "",
      );
    });
    e.preventDefault();
  } else if (e.key === "Backspace") {
    state.typing = state.typing.slice(0, -1);
    renderPanes(ctx.root, state, ["suite"]);
    e.preventDefault();
  } else if (e.key.length === 1 && state.typing.length < 46) {
    state.typing += e.key;
    renderPanes(ctx.root, state, ["suite"]);
    e.preventDefault();
  }
}
