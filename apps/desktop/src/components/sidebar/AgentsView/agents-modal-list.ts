import type { AgentInfo, SessionSummary } from "../../../electron.d";
import type { ProjectInfo } from "../../../store/project-store";
import { matchesQueryWords } from "../../../lib/agent-query";
import { resolveAgentTitle } from "../../../hooks/useAgentDisplay";
import { isWindowsPath, isWithin, normalizePath } from "../../../lib/path-within";

/** The modal's tabs. Open: the agent's pane is in a workspace right now. */
export type AgentTab = "all" | "open" | "closed";

/**
 * The project a row is filed under: a Manor project, or, for a cwd no project
 * contains, a pseudo-project for that folder (no color).
 */
export interface ModalProject {
  /**
   * A Manor project's id; `folder:<hostId>:<path>` for a folder no project
   * contains; `name:<name>` for an Agent's project that no longer exists.
   */
  key: string;
  name: string;
  /** The project's color token; null when uncolored or a pseudo-project. */
  color: string | null;
  /** A folder pseudo-project's full path, for its tooltip and to tell same-named folders apart. */
  path?: string;
}

/**
 * One line of the Agents modal: an **Agent**, a **Session**, or both when the
 * Session is the Agent's (same kind and CLI session id). The Agent wins for
 * live state and name; the Session fills in the title, first prompt, branch
 * and last activity. A Session with no Agent is "outside Manor".
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

// ── Paths ──

function pathSegments(path: string): string[] {
  return path.split(isWindowsPath(path) ? /[\\/]/ : "/").filter(Boolean);
}

// ── Projects ──

/**
 * The store's projects, ready for matching cwds, with one `ModalProject` per
 * project, folder and name, so rows built at different times share them.
 */
interface ProjectIndex {
  byId: Map<string, ModalProject>;
  /** Every project or workspace path, normalized, longest first, by host. */
  bases: Map<string, Array<{ path: string; project: ModalProject }>>;
  pseudo: Map<string, ModalProject>;
  /** Agent-only rows' projects, per Agent object. */
  byAgent: WeakMap<AgentInfo, ModalProject>;
}

function indexProjects(projects: readonly ProjectLike[]): ProjectIndex {
  const byId = new Map<string, ModalProject>();
  const bases = new Map<string, Array<{ path: string; project: ModalProject }>>();
  for (const p of projects) {
    const project: ModalProject = { key: p.id, name: p.name, color: p.color };
    byId.set(p.id, project);
    const list = bases.get(p.hostId) ?? [];
    for (const raw of [p.path, ...p.workspaces.map((w) => w.path)]) {
      const path = normalizePath(raw ?? "");
      if (path) list.push({ path, project });
    }
    bases.set(p.hostId, list);
  }
  for (const list of bases.values()) list.sort((a, b) => b.path.length - a.path.length);
  return { byId, bases, pseudo: new Map(), byAgent: new WeakMap() };
}

/**
 * The project on `hostId` whose path, or one of whose workspace paths, is
 * `cwd` or an ancestor of it; the longest such path wins, so a worktree
 * nested under another project's folder files under its own project.
 */
function matchProject(index: ProjectIndex, hostId: string, cwd: string): ModalProject | null {
  const path = normalizePath(cwd);
  if (!path) return null;
  for (const base of index.bases.get(hostId) ?? []) {
    if (isWithin(path, base.path)) return base.project;
  }
  return null;
}

function pseudoProject(index: ProjectIndex, key: string, make: () => ModalProject): ModalProject {
  let project = index.pseudo.get(key);
  if (!project) {
    project = make();
    index.pseudo.set(key, project);
  }
  return project;
}

function folderProject(index: ProjectIndex, hostId: string, cwd: string): ModalProject {
  const path = normalizePath(cwd);
  return pseudoProject(index, `folder:${hostId}:${path}`, () => {
    const name = pathSegments(cwd).pop();
    return name
      ? { key: `folder:${hostId}:${path}`, name, color: null, path: cwd.trim() }
      : { key: `folder:${hostId}:`, name: "No project", color: null };
  });
}

function agentOwnProject(index: ProjectIndex, agent: AgentInfo): ModalProject | null {
  return agent.projectId ? index.byId.get(agent.projectId) ?? null : null;
}

function agentOnlyProject(index: ProjectIndex, agent: AgentInfo): ModalProject {
  const cached = index.byAgent.get(agent);
  if (cached) return cached;
  const cwd = agent.workspacePath || agent.cwd || "";
  const project =
    agentOwnProject(index, agent) ??
    matchProject(index, agent.hostId, cwd) ??
    (agent.projectName
      ? pseudoProject(index, `name:${agent.projectName}`, () => ({
          key: `name:${agent.projectName}`,
          name: agent.projectName as string,
          color: null,
        }))
      : folderProject(index, agent.hostId, cwd));
  index.byAgent.set(agent, project);
  return project;
}

// ── Rows ──

/**
 * The Sessions as rows of their own, newest first, each filed under its
 * project. Depends only on the Sessions and projects, so a status change to
 * some Agent doesn't redo the project matching.
 */
export interface SessionRows {
  rows: ModalRow[];
  index: ProjectIndex;
}

function sessionKey(kind: string, sessionId: string): string {
  return `${kind}\0${sessionId}`;
}

const byActivity = (a: ModalRow, b: ModalRow) =>
  b.activityAt.localeCompare(a.activityAt) || a.id.localeCompare(b.id);

export function sessionRows(
  sessions: readonly SessionSummary[],
  projects: readonly ProjectLike[],
): SessionRows {
  const index = indexProjects(projects);
  const seen = new Set<string>();
  const rows: ModalRow[] = [];
  for (const session of sessions) {
    const key = sessionKey(session.kind, session.sessionId);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      id: `session:${session.hostId}:${session.id}`,
      session,
      project:
        matchProject(index, session.hostId, session.cwd) ??
        folderProject(index, session.hostId, session.cwd),
      activityAt: session.updatedAt,
    });
  }
  return { rows: rows.sort(byActivity), index };
}

/** The Agents a list shows: the store's, joined by main's search page while searching. */
export function listedAgents(
  storeAgents: readonly AgentInfo[],
  searchAgents: readonly AgentInfo[],
  query: string,
): readonly AgentInfo[] {
  if (!query.trim()) return storeAgents;
  const ids = new Set(storeAgents.map((a) => a.id));
  return [...storeAgents, ...searchAgents.filter((a) => !ids.has(a.id))];
}

function sameRow(a: ModalRow, b: ModalRow): boolean {
  return (
    a.agent === b.agent &&
    a.session === b.session &&
    a.project === b.project &&
    a.activityAt === b.activityAt
  );
}

/**
 * Agents and Sessions as one list, newest activity first, one row per
 * (agent kind, session id): an Agent and its Session match on those alone,
 * since one host can be listed under two host ids. `agents` are the ones to
 * list; `knownAgents` is every Agent main knows, used only to recognise a
 * Session as Manor's when its Agent isn't among `agents` yet (an older page),
 * so it isn't shown as outside Manor. An entry of `agents` wins over its
 * `knownAgents` copy.
 *
 * A row whose Agent, Session and project are the objects `previous` had is
 * that same row object, so memoized rows don't redraw.
 */
export function mergeModalRows(
  input: {
    sessions: SessionRows;
    agents: readonly AgentInfo[];
    knownAgents: readonly AgentInfo[];
  },
  previous?: ReadonlyMap<string, ModalRow>,
): ModalRow[] {
  const { sessions, agents, knownAgents } = input;
  const { index } = sessions;
  const byKey = new Map<string, AgentInfo>();
  for (const a of knownAgents) byKey.set(sessionKey(a.agentKind, a.agentSessionId), a);
  for (const a of agents) byKey.set(sessionKey(a.agentKind, a.agentSessionId), a);

  const reuse = (row: ModalRow): ModalRow => {
    const old = previous?.get(row.id);
    return old && sameRow(old, row) ? old : row;
  };

  const used = new Set<string>();
  const fromSessions: ModalRow[] = [];
  for (const base of sessions.rows) {
    const session = base.session as SessionSummary;
    const agent = byKey.get(sessionKey(session.kind, session.sessionId));
    if (!agent) {
      fromSessions.push(base);
      continue;
    }
    if (used.has(agent.id)) continue;
    used.add(agent.id);
    fromSessions.push(
      reuse({
        id: agent.id,
        agent,
        session,
        project: agentOwnProject(index, agent) ?? base.project,
        activityAt: session.updatedAt,
      }),
    );
  }

  const agentOnly: ModalRow[] = [];
  for (const agent of agents) {
    if (used.has(agent.id)) continue;
    used.add(agent.id);
    agentOnly.push(
      reuse({
        id: agent.id,
        agent,
        project: agentOnlyProject(index, agent),
        activityAt: agent.createdAt,
      }),
    );
  }
  agentOnly.sort(byActivity);

  // Both runs are newest first; interleave them.
  const rows: ModalRow[] = [];
  let i = 0;
  let j = 0;
  while (i < fromSessions.length || j < agentOnly.length) {
    const takeSession =
      j >= agentOnly.length ||
      (i < fromSessions.length && byActivity(fromSessions[i], agentOnly[j]) <= 0);
    rows.push(takeSession ? fromSessions[i++] : agentOnly[j++]);
  }
  return rows;
}

/**
 * The title a Session shows on its own: its title, else its first prompt,
 * else its folder's name, else "Session".
 */
export function sessionTitle(session: SessionSummary): string {
  return (
    session.title.trim() ||
    session.firstPrompt.trim() ||
    pathSegments(session.cwd).pop() ||
    "Session"
  );
}

/**
 * The title a row shows: the Agent's (pinned name, live title, synced name),
 * then the Session's.
 */
export function modalRowTitle(row: ModalRow, liveTitle: string | null): string {
  if (row.agent) {
    const title = resolveAgentTitle(row.agent, liveTitle);
    if (title !== "Agent" || row.agent.name || !row.session) return title;
  }
  return row.session ? sessionTitle(row.session) : "Agent";
}

/** Whether a row is in the Open tab: it has an Agent whose pane is in a workspace now. */
export function isRowOpen(row: ModalRow, openPaneIds: ReadonlySet<string>): boolean {
  const paneId = row.agent?.paneId;
  return !!paneId && openPaneIds.has(paneId);
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
 * The rows for a query and tab, before the project filter. With a query,
 * rows are matched here too: by the shown title, which only the window
 * knows, by the Session's title, first prompt and folder, and against a
 * search page from an older query.
 */
export function filterModalRows(
  rows: readonly ModalRow[],
  input: {
    query: string;
    tab: AgentTab;
    openPaneIds: ReadonlySet<string>;
    liveTitles: Readonly<Record<string, string>>;
  },
): readonly ModalRow[] {
  const { tab, openPaneIds, liveTitles } = input;
  const query = input.query.trim();
  if (!query && tab === "all") return rows;
  const wantOpen = tab === "open";
  return rows.filter(
    (r) =>
      (tab === "all" || isRowOpen(r, openPaneIds) === wantOpen) &&
      (!query || matchesRow(r, query, liveTitles)),
  );
}

/** A project filter chip: the project, and the label it shows. */
export interface ProjectChip {
  project: ModalProject;
  label: string;
}

/**
 * One chip per project present in `rows`, the most recently active first.
 * `selected` stays a chip even when no row is left in it, so the filter
 * that's on can always be seen and turned off. A folder whose name another
 * chip also has is labelled with its parent too (`code/manor`).
 */
export function projectChips(
  rows: readonly ModalRow[],
  selected: ModalProject | null,
): ProjectChip[] {
  // Rows come newest first, so first sight is latest activity.
  const projects = new Map<string, ModalProject>();
  for (const r of rows) if (!projects.has(r.project.key)) projects.set(r.project.key, r.project);
  if (selected && !projects.has(selected.key)) projects.set(selected.key, selected);

  const nameCount = new Map<string, number>();
  for (const p of projects.values()) nameCount.set(p.name, (nameCount.get(p.name) ?? 0) + 1);
  return [...projects.values()].map((project) => {
    const segments = project.path ? pathSegments(project.path) : [];
    const label =
      (nameCount.get(project.name) ?? 0) > 1 && segments.length > 1
        ? segments.slice(-2).join("/")
        : project.name;
    return { project, label };
  });
}
