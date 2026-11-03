/**
 * The app's chrome as HTML strings, drawn from plain data and knowing nothing
 * of what the panes hold: each function mirrors the app component it names.
 * `renderWindow` takes the main area as a parameter, so a screen can put
 * anything in the panel. Classes are shell.css's `ma-*`.
 */
import { CLOSE_PANE_ICON, MANOR_LOGO, SPLIT_PANE_ICON, icon } from "./icons";
import type { AgentStatus, WorkspaceIndicator } from "./state";

export function esc(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

export type WorkspaceRow = {
  id: string;
  /** What the row calls it: "local" for the main checkout, else the workspace's name. */
  name: string;
  branch: string;
  isMain: boolean;
  active: boolean;
  indicator: WorkspaceIndicator;
};

export type ProjectRow = {
  name: string;
  /** A palette variable's name, as `project.color` is in the app. */
  color?: string;
  selected: boolean;
  workspaces: WorkspaceRow[];
};

export type AgentRow = { id: string; title: string; status: AgentStatus | null; pulse: boolean };

export type AgentGroup = { project: string; agents: AgentRow[] };

export type TabData = { id: string; title: string; active: boolean; status: AgentStatus | null; pulse: boolean };

export type PaneData = {
  /** `data-pane`, if clicking the pane should mean anything. */
  id?: string;
  title: string;
  focused: boolean;
  /** Agent panes have a chat view, and with it the header's chat toggle. */
  hasChat: boolean;
  /** The terminal's rows, already HTML. */
  body: string;
};

export type WindowData = {
  projects: ProjectRow[];
  agentGroups: AgentGroup[];
  /** The bell's unread badge. */
  unread: boolean;
  /** The status bar's trail: project, then workspace. */
  crumbs: string[];
  /** Everything inside the workspace stack: `tabbedPanel(...)`, or a screen of its own. */
  main: string;
};

const iconButton = (className: string, label: string, content: string, disabled = false) =>
  `<button class="${className}" type="button" tabindex="-1" aria-label="${label}"${disabled ? " disabled" : ""}>${content}</button>`;

// ---- agent status marks --------------------------------------------------

const SPINNER_TITLES = { working: "Agent working", thinking: "Agent thinking", idle: "Agent idle" } as const;

function spinner(variant: keyof typeof SPINNER_TITLES): string {
  return `<span><span class="ma-spinner ma-spinner-${variant}" title="${SPINNER_TITLES[variant]}"></span></span>`;
}

/** components/ui/AgentDot: draws nothing for idle, a still ring for a read turn, a pulse for an unread one. */
export function agentDot(status: AgentStatus | null, pulse: boolean): string {
  if (!status || status === "idle") return "";
  if (status === "working" || status === "thinking") return spinner(status);
  if (status === "responded") return pulse ? '<span class="ma-dot ma-dot-responded"></span>' : spinner("idle");
  if (status === "requires_input") return '<span class="ma-dot ma-dot-input"><span class="ma-hand">👋</span></span>';
  return '<span class="ma-dot ma-dot-error"></span>';
}

/** components/sidebar/WorkspaceIndicatorDot. */
function workspaceIndicatorDot(indicator: NonNullable<WorkspaceIndicator>): string {
  const { kind, pulse } = indicator;
  if (kind === "thinking" || kind === "working") return spinner(kind);
  if (kind === "needs_you") {
    return `<span class="ma-ws-dot ma-needs-you${pulse ? " ma-pulse" : ""}" title="Needs your input"></span>`;
  }
  return '<span class="ma-ws-dot ma-done-unread ma-pulse" title="Agent responded"></span>';
}

// ---- sidebar -------------------------------------------------------------

/**
 * components/window-lead/WindowLead: back and forward with nowhere to go yet,
 * and the bell. The traffic lights are native in the app, so nothing there draws
 * them; here they're drawn in the room its `lightsSpacer` leaves.
 */
function windowLead(unread: boolean): string {
  return (
    `<div class="ma-lead"><div class="ma-lights" aria-hidden="true"><span></span><span></span><span></span></div><div class="ma-lead-controls">` +
    iconButton("ma-btn ma-ghost ma-lead-button", "Navigate back", icon("arrow-left", 14), true) +
    iconButton("ma-btn ma-ghost ma-lead-button", "Navigate forward", icon("arrow-right", 14), true) +
    iconButton(
      "ma-btn ma-ghost ma-lead-button ma-bell",
      "Notifications",
      icon("bell", 14) + (unread ? '<span class="ma-bell-badge"></span>' : ""),
    ) +
    `</div></div>`
  );
}

const navRow = (name: "layout-dashboard" | "list-todo" | "search", label: string) =>
  `<div class="ma-home-row"><span class="ma-home-icon">${icon(name, 14)}</span><span class="ma-home-label">${label}</span></div>`;

/** components/sidebar/ProjectItem's WorkspaceItem. */
function workspaceRow(w: WorkspaceRow): string {
  const mark = w.indicator ? workspaceIndicatorDot(w.indicator) : icon(w.isMain ? "git-branch" : "folder-git-2", 12);
  return (
    `<div class="ma-workspace${w.active ? " ma-workspace-active" : ""}" data-ws="${esc(w.id)}">` +
    `<span class="ma-workspace-icon">${mark}</span>` +
    `<div class="ma-workspace-label"><div class="ma-workspace-name-row"><span class="ma-workspace-name">${esc(w.name)}</span></div>` +
    `<div class="ma-workspace-branch-row"><span class="ma-workspace-branch">${esc(w.branch)}</span></div></div></div>`
  );
}

/** components/sidebar/ProjectItem, expanded. */
function projectRow(p: ProjectRow): string {
  const style = p.color ? ` style="--project-color: var(--${esc(p.color)})"` : "";
  const actions = (
    [
      ["New Workspace", "plus"],
      ["New Folder", "folder-plus"],
      ["Project Settings", "settings"],
    ] as const
  )
    .map(([label, name]) => iconButton("ma-btn ma-ghost ma-project-action", label, icon(name, 13)))
    .join("");
  return (
    `<div class="${p.selected ? "ma-project-selected" : ""}"${style}>` +
    `<div class="ma-project-header"><span class="ma-project-chevron">${icon("chevron-right", 12)}</span>` +
    `<span class="ma-project-swatch" aria-hidden="true"></span><span class="ma-project-name">${esc(p.name)}</span>` +
    `<span class="ma-project-actions">${actions}</span></div>` +
    `<div class="ma-project-body"><div class="ma-workspaces">${p.workspaces.map(workspaceRow).join("")}</div></div></div>`
  );
}

/** components/sidebar/AgentsList. */
function agentsList(groups: AgentGroup[]): string {
  if (!groups.some((g) => g.agents.length)) return "";
  const rows = groups
    .map(
      (g) =>
        `<div class="ma-agent-group"><div class="ma-agent-group-header">${esc(g.project)}</div>` +
        g.agents
          .map((a) => {
            // AgentDot draws nothing for idle; the row still needs its icon.
            const dot = !a.status || a.status === "idle" ? spinner("idle") : agentDot(a.status, a.pulse);
            return (
              `<div class="ma-agent-item" data-agent="${esc(a.id)}">${dot}<span class="ma-agent-name">${esc(a.title)}</span>` +
              iconButton("ma-btn ma-ghost ma-sm ma-agent-close", "Close agent", icon("x", 12)) +
              `</div>`
            );
          })
          .join("") +
        `</div>`,
    )
    .join("");
  return (
    `<div class="ma-agents-section"><div class="ma-section-header">` +
    `<span class="ma-section-title"><span class="ma-chevron-open">${icon("chevron-right", 12)}</span>${icon("bot", 12)}Agents</span>` +
    `<button class="ma-btn ma-ghost ma-sm ma-section-action" type="button" tabindex="-1">View All</button></div>` +
    `<div class="ma-agent-groups">${rows}</div></div>`
  );
}

/** components/sidebar/Sidebar. */
export function sidebar(projects: ProjectRow[], agentGroups: AgentGroup[]): string {
  return (
    `<div class="ma-sidebar-frame"><div class="ma-sidebar"><div class="ma-sidebar-content">` +
    `<nav class="ma-nav" aria-label="Main">${navRow("layout-dashboard", "Dashboard")}${navRow("list-todo", "Tasks")}${navRow("search", "Search")}</nav>` +
    `<div class="ma-nav-divider" role="separator"></div>` +
    `<div class="ma-projects-section"><div class="ma-projects-row"><span class="ma-projects-icon">${icon("folders", 12)}</span>` +
    `<span class="ma-projects-label">Projects</span>${iconButton("ma-btn ma-ghost ma-sm ma-projects-add", "Add project", icon("plus", 13))}</div>` +
    `<div class="ma-projects-scroll"><div class="ma-projects">${projects.map(projectRow).join("")}</div></div></div>` +
    agentsList(agentGroups) +
    `</div></div></div>`
  );
}

// ---- panel: tab bar, panes -----------------------------------------------

/** components/tabbar/TabButton. */
function tabButton(tab: TabData): string {
  return (
    `<div class="ma-tab${tab.active ? " ma-tab-active" : ""}" data-tab="${esc(tab.id)}">` +
    agentDot(tab.status, tab.pulse) +
    `<span class="ma-tab-title">${esc(tab.title)}</span>` +
    iconButton("ma-btn ma-ghost ma-sm ma-tab-close", "Close tab", icon("x", 12)) +
    `</div>`
  );
}

/** components/tabbar/TabBar/TabBar. */
export function tabBar(tabs: TabData[]): string {
  return (
    `<div class="ma-tab-bar"><div class="ma-tabs">${tabs.map(tabButton).join("")}` +
    iconButton("ma-tab-add", "New tab", icon("plus", 14)) +
    `</div><div class="ma-tab-spacer"></div></div>`
  );
}

/** components/panels/LeafPanel: one frame around a tab bar and whatever the selected tab holds. */
export function tabbedPanel(tabs: TabData[], body: string): string {
  return `<div class="ma-panel">${tabBar(tabs)}<div class="ma-panel-body">${body}</div></div>`;
}

/** components/workspace-panes/LeafPane: header strip over a terminal. */
export function leafPane(pane: PaneData): string {
  const id = pane.id ? ` data-pane="${esc(pane.id)}"` : "";
  const actions =
    (pane.hasChat ? iconButton("ma-pane-btn", "Show chat", icon("message-square", 12)) : "") +
    iconButton("ma-pane-btn", "Split pane", SPLIT_PANE_ICON) +
    iconButton("ma-pane-btn", "Close pane", CLOSE_PANE_ICON);
  return (
    `<div class="ma-leaf"${id}>` +
    `<div class="ma-pane-bar${pane.focused ? " ma-pane-bar-focused" : ""}"><span class="ma-pane-title">${esc(pane.title)}</span>` +
    `<div class="ma-pane-actions">${actions}</div></div>` +
    `<div class="ma-leaf-terminal"><div class="ma-term">${pane.body}</div></div></div>`
  );
}

/** components/workspace-panes/SplitFrame, at the even ratio. */
export function splitPanes(direction: "horizontal" | "vertical", first: string, second: string): string {
  return (
    `<div class="ma-split ma-split-${direction}"><div class="ma-split-child">${first}</div>` +
    `<div class="ma-divider"></div><div class="ma-split-child">${second}</div></div>`
  );
}

// ---- status bar, window --------------------------------------------------

/** components/statusbar/StatusBar/StatusBar. */
export function statusBar(crumbs: string[]): string {
  const trail = crumbs
    .map((c) => `<span class="ma-segment">${esc(c)}</span>`)
    .join('<span class="ma-separator">&gt;</span>');
  return (
    `<div class="ma-status-bar"><div class="ma-status-left">${trail}</div><div class="ma-status-right">` +
    iconButton("ma-logo-button", "Send feedback", icon("message-square-plus", 12)) +
    iconButton("ma-logo-button", "About Manor", MANOR_LOGO) +
    `</div></div>`
  );
}

/** App.tsx's frame: the sidebar column and, beside it, the workspace stack above the status bar. */
export function renderWindow(data: WindowData): string {
  return (
    `<div class="ma-app-body">${windowLead(data.unread)}` +
    `<div class="ma-sidebar-column">${sidebar(data.projects, data.agentGroups)}</div>` +
    `<div class="ma-main-content"><div class="ma-workspace-stack">${data.main}</div>${statusBar(data.crumbs)}</div>` +
    `</div>`
  );
}
