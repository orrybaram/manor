import type { AgentInfo, SessionSummary } from "../../../electron.d";
import type { ProjectInfo } from "../../../store/project-store";
import { matchesQueryWords } from "../../../lib/agent-query";
import { resolveAgentTitle } from "../../../hooks/useAgentDisplay";

/** The modal's tabs. Open: the agent's pane is in a workspace right now. */
export type AgentTab = "all" | "open" | "closed";

/**
 * The project a row is filed under: a Manor project, or, for a cwd no project
 * contains, a pseudo-project named after the folder (no color).
 */
export interface ModalProject {
  /** A Manor project's id; `folder:<name>` or `name:<name>` for a pseudo-project. */
  key: string;
  name: string;
  /** The project's color token; null when uncolored or a pseudo-project. */
  color: string | null;
}

/**
 * One line of the Agents modal: an **Agent**, a **Session**, or both when the
 * Session is the Agent's (same host, kind and CLI session id). The Agent wins
 * for live state and name; the Session fills in the title, first prompt,
 * branch and last activity. A Session with no Agent is "outside Manor".
 */
export interface ModalRow {
  /** The Agent's id, else `session:<hostId>:<session id>`. */
  id: string;
  agent?: AgentInfo;
  session?: SessionSummary;
  project: ModalProject;
  /**
   * What the list sorts and groups by day on: the Session's last activity
   * (its transcript's mtime) when known, else the Agent's creation time,
   * which is the order main pages Agents in.
   */
  activityAt: string;
}

type ProjectLike = Pick<ProjectInfo, "id" | "name" | "path" | "color" | "hostId"> & {
  workspaces: ReadonlyArray<{ path: string }>;
};

function trimSeparators(path: string): string {
  return path.replace(/[\\/]+$/, "");
}

function isWithin(cwd: string, base: string): boolean {
  return cwd === base || cwd.startsWith(`${base}/`) || cwd.startsWith(`${base}\\`);
}

function folderProject(cwd: string): ModalProject {
  const name = cwd.split(/[\\/]/).filter(Boolean).pop();
  return name
    ? { key: `folder:${name}`, name, color: null }
    : { key: "folder:", name: "No project", color: null };
}

function asModalProject(p: ProjectLike): ModalProject {
  return { key: p.id, name: p.name, color: p.color };
}

/**
 * The project on `hostId` whose path, or one of whose workspace paths, is
 * `cwd` or an ancestor of it; the longest such path wins, so a worktree
 * nested under another project's folder files under its own project.
 */
function matchProject(
  projects: readonly ProjectLike[],
  hostId: string,
  rawCwd: string,
): ProjectLike | null {
  const cwd = trimSeparators(rawCwd);
  if (!cwd) return null;
  let best: ProjectLike | null = null;
  let bestLength = -1;
  for (const p of projects) {
    if (p.hostId !== hostId) continue;
    for (const raw of [p.path, ...p.workspaces.map((w) => w.path)]) {
      const base = trimSeparators(raw ?? "");
      if (base && base.length > bestLength && isWithin(cwd, base)) {
        best = p;
        bestLength = base.length;
      }
    }
  }
  return best;
}

function rowProject(
  projects: readonly ProjectLike[],
  agent: AgentInfo | undefined,
  session: SessionSummary | undefined,
): ModalProject {
  if (agent?.projectId) {
    const own = projects.find((p) => p.id === agent.projectId);
    if (own) return asModalProject(own);
  }
  const hostId = agent?.hostId ?? session?.hostId ?? "local";
  const cwd = session?.cwd || agent?.workspacePath || agent?.cwd || "";
  const match = matchProject(projects, hostId, cwd);
  if (match) return asModalProject(match);
  if (agent?.projectName) {
    return { key: `name:${agent.projectName}`, name: agent.projectName, color: null };
  }
  return folderProject(cwd);
}

function sessionKey(hostId: string, kind: string, sessionId: string): string {
  return `${hostId}\0${kind}\0${sessionId}`;
}

const agentKey = (a: AgentInfo) => sessionKey(a.hostId, a.agentKind, a.agentSessionId);

/** Whether a row is in the Open tab: it has an Agent whose pane is in a workspace now. */
export function isRowOpen(row: ModalRow, openPaneIds: ReadonlySet<string>): boolean {
  const paneId = row.agent?.paneId;
  return !!paneId && openPaneIds.has(paneId);
}

/**
 * Agents and Sessions as one list, newest activity first, one row per
 * (host, kind, session id). `agents` are the ones to list; `knownAgents` is
 * every Agent main knows, used only to recognise a Session as Manor's when
 * its Agent isn't among `agents` yet (an older page), so it isn't shown as
 * outside Manor. An entry of `agents` wins over its `knownAgents` copy.
 */
export function mergeModalRows(input: {
  agents: readonly AgentInfo[];
  knownAgents: readonly AgentInfo[];
  sessions: readonly SessionSummary[];
  projects: readonly ProjectLike[];
}): ModalRow[] {
  const { agents, knownAgents, sessions, projects } = input;
  const byKey = new Map<string, AgentInfo>();
  for (const a of knownAgents) byKey.set(agentKey(a), a);
  for (const a of agents) byKey.set(agentKey(a), a);

  const rows: ModalRow[] = [];
  const used = new Set<string>();
  for (const session of sessions) {
    const agent = byKey.get(sessionKey(session.hostId, session.kind, session.sessionId));
    if (agent && used.has(agent.id)) continue;
    if (agent) used.add(agent.id);
    rows.push({
      id: agent ? agent.id : `session:${session.hostId}:${session.id}`,
      agent,
      session,
      project: rowProject(projects, agent, session),
      activityAt: session.updatedAt,
    });
  }
  for (const agent of agents) {
    if (used.has(agent.id)) continue;
    used.add(agent.id);
    rows.push({
      id: agent.id,
      agent,
      project: rowProject(projects, agent, undefined),
      activityAt: agent.createdAt,
    });
  }
  return rows.sort(
    (a, b) => b.activityAt.localeCompare(a.activityAt) || a.id.localeCompare(b.id),
  );
}

/**
 * The title a row shows: the Agent's (pinned name, live title, synced name),
 * then the Session's own title.
 */
export function modalRowTitle(row: ModalRow, liveTitle: string | null): string {
  if (row.agent) {
    const title = resolveAgentTitle(row.agent, liveTitle);
    if (title !== "Agent" || row.agent.name) return title;
  }
  return row.session?.title || "Agent";
}

function matchesRow(
  row: ModalRow,
  query: string,
  liveTitles: Readonly<Record<string, string>>,
): boolean {
  const { agent, session } = row;
  const liveTitle = agent?.paneId ? liveTitles[agent.paneId] ?? null : null;
  return matchesQueryWords(
    [
      agent?.name,
      modalRowTitle(row, liveTitle),
      agent?.projectName,
      agent?.workspacePath,
      session?.title,
      session?.firstPrompt,
      session?.cwd,
      row.project.name,
    ],
    query,
  );
}

/**
 * The rows the Agents modal lists for a query and tab, before the project
 * filter, newest first. With a query, main's search page joins the store's
 * agents (the store's copy of an agent wins, being live), and every row is
 * filtered here too: by the shown title, which only the window knows, by the
 * Session's title, first prompt and folder, and against a search page from
 * an older query.
 */
export function agentsModalRows(input: {
  storeAgents: readonly AgentInfo[];
  searchAgents: readonly AgentInfo[];
  knownAgents?: readonly AgentInfo[];
  sessions?: readonly SessionSummary[];
  projects?: readonly ProjectLike[];
  query: string;
  tab: AgentTab;
  openPaneIds: ReadonlySet<string>;
  liveTitles: Readonly<Record<string, string>>;
}): ModalRow[] {
  const { storeAgents, searchAgents, tab, openPaneIds, liveTitles } = input;
  const query = input.query.trim();

  const agents: AgentInfo[] = [...storeAgents];
  if (query) {
    const ids = new Set(agents.map((a) => a.id));
    for (const a of searchAgents) if (!ids.has(a.id)) agents.push(a);
  }
  let rows = mergeModalRows({
    agents,
    knownAgents: input.knownAgents ?? [],
    sessions: input.sessions ?? [],
    projects: input.projects ?? [],
  });
  if (query) rows = rows.filter((r) => matchesRow(r, query, liveTitles));
  if (tab !== "all") {
    const wantOpen = tab === "open";
    rows = rows.filter((r) => isRowOpen(r, openPaneIds) === wantOpen);
  }
  return rows;
}

/**
 * One chip per project present in `rows`, the most recently active first.
 * `selected` stays a chip even when no row is left in it, so the filter
 * that's on can always be seen and turned off.
 */
export function projectChips(
  rows: readonly ModalRow[],
  selected: ModalProject | null,
): ModalProject[] {
  // Rows come newest first, so first sight is latest activity.
  const chips = new Map<string, ModalProject>();
  for (const r of rows) if (!chips.has(r.project.key)) chips.set(r.project.key, r.project);
  if (selected && !chips.has(selected.key)) chips.set(selected.key, selected);
  return [...chips.values()];
}
