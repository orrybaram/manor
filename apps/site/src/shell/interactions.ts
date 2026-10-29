/**
 * What the shell does when poked: Codex's Yes/Always/No, switching workspaces
 * and agents, focusing panes, and typing into "Automations suite".
 */
import { esc } from "./render";
import { isAgentId, type ShellState } from "./state";

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
      a.status = "responded";
      a.log = ["\n<span class=\"b\">•</span> Skipped <b>pnpm vitest run FileTree</b>. What should I do instead?\n\n"];
    } else {
      a.status = "working";
      a.log = ['\n<span class="b">•</span> Ran <b>pnpm vitest run FileTree</b>\n  <span class="d">└ running…</span>\n'];
      ctx.later(1800, () => {
        a.status = "responded";
        a.log = [
          '\n<span class="b">•</span> Ran <b>pnpm vitest run FileTree</b>\n  <span class="d">└</span> <span class="g">✓ 18 passed (1.2s)</span>\n\n' +
            '<span class="b">•</span> Go to File now opens from the drawer, with a test.\n\n',
        ];
      });
    }
    ctx.render();
    return;
  }
  if (ws) {
    const w = state.workspaces.find((x) => x.id === ws);
    if (!w) return;
    state.ws = w.id;
    state.focus = w.panes[0] ?? null;
    ctx.render();
    return;
  }
  if (isAgentId(state, agent)) {
    state.ws = state.agents[agent].ws;
    state.focus = agent;
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
    a.log.push(`<span class="d">&gt;</span> ${esc(said)}\n\n`);
    a.status = "thinking";
    ctx.render();
    ctx.later(900, () => {
      a.status = "working";
    });
    ctx.later(2400, () => {
      a.status = "responded";
      a.log.push('<span class="g">●</span> On it. That would land in its own worktree, so\n  nothing else in the house is touched.\n\n');
      if (a.log.length > 4) a.log.splice(0, 2);
    });
    e.preventDefault();
  } else if (e.key === "Backspace") {
    state.typing = state.typing.slice(0, -1);
    ctx.render();
    e.preventDefault();
  } else if (e.key.length === 1 && state.typing.length < 46) {
    state.typing += e.key;
    ctx.render();
    e.preventDefault();
  }
}
