/**
 * Turns the shell's state into the chrome's data and draws it. The chrome
 * itself (chrome.ts) and the pane contents (terminals.ts) don't read state.
 */
import { leafPane, renderWindow, splitPanes, tabbedPanel, type WindowData } from "./chrome";
import { SHELL_BODY, paneBody } from "./terminals";
import { agentPulse, openWorkspace, projectOf, rollup, toWorkspaceIndicator, type AgentId, type ShellState } from "./state";

function agentPane(state: ShellState, id: AgentId): string {
  return leafPane({
    id,
    title: state.agents[id].title,
    focused: state.focus === id,
    hasChat: true,
    body: paneBody(state, id),
  });
}

/** The tab's pane tree: one pane, or two columns of two as the app's splits nest. */
function panes(state: ShellState, ids: AgentId[]): string {
  const [a, b, c, d] = ids;
  if (!a) return leafPane({ title: "manor", focused: true, hasChat: false, body: SHELL_BODY });
  if (!b || !c || !d) return agentPane(state, a);
  return splitPanes(
    "horizontal",
    splitPanes("vertical", agentPane(state, a), agentPane(state, c)),
    splitPanes("vertical", agentPane(state, b), agentPane(state, d)),
  );
}

export function windowData(state: ShellState): WindowData {
  const w = openWorkspace(state);
  const open = projectOf(state, w.id);
  const focused = state.focus && w.panes.includes(state.focus) ? state.focus : w.panes[0];
  const tab = rollup(state, w.panes);
  const agents = Object.entries(state.agents) as [AgentId, ShellState["agents"][AgentId]][];
  return {
    projects: state.projects.map((p) => ({
      name: p.name,
      color: p.color,
      selected: p === open,
      workspaces: p.workspaces.map((x) => ({
        id: x.id,
        name: x.isMain ? "local" : x.id,
        branch: x.branch,
        isMain: !!x.isMain,
        active: x.id === w.id,
        indicator: toWorkspaceIndicator(rollup(state, x.panes)),
      })),
    })),
    agentGroups: state.projects.map((p) => ({
      project: p.name,
      agents: agents
        .filter(([, a]) => p.workspaces.some((x) => x.id === a.ws))
        .map(([id, a]) => ({ id, title: a.title, status: a.status, pulse: agentPulse(state, a) })),
    })),
    unread: agents.some(([, a]) => agentPulse(state, a)),
    crumbs: [open.name, w.branch],
    main: tabbedPanel(
      [
        {
          id: w.id,
          title: focused ? state.agents[focused].title : "manor",
          active: true,
          status: tab.status,
          pulse: tab.pulse,
        },
      ],
      panes(state, w.panes),
    ),
  };
}

export function renderShell(root: HTMLElement, state: ShellState): void {
  root.innerHTML = renderWindow(windowData(state));
}

/** Redraw just these panes' terminals, so spinners and hovers elsewhere are left alone. */
export function renderPanes(root: HTMLElement, state: ShellState, ids: readonly AgentId[]): void {
  for (const id of ids) {
    const el = root.querySelector(`[data-pane="${id}"] .ma-term`);
    if (el) el.innerHTML = paneBody(state, id);
  }
}

/** How often the ambient frame counts up. */
export const TICK_MS = 250;

/** One ambient frame: Claude's timer, opencode's moon. */
export function tickAgents(root: HTMLElement, state: ShellState): void {
  state.tick++;
  const hero = state.agents.hero;
  if (hero.status === "working" && state.tick % 4 === 0) hero.secs++;
  renderPanes(root, state, ["hero", "sweep"]);
}
