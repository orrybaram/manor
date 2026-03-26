import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { safeStorage } from "electron";

export interface LinearTeam {
  id: string;
  name: string;
  key: string;
}

export interface LinearAssociation {
  teamId: string;
  teamName: string;
  teamKey: string;
}

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  url: string;
  branchName: string;
  priority: number;
  state: { name: string; type: string };
  labels: Array<{ name: string; color: string }>;
}

export interface LinkedIssue {
  id: string;
  identifier: string;
  title: string;
  url: string;
}

export interface LinearIssueDetail extends LinearIssue {
  description: string | null;
  labels: Array<{ id: string; name: string; color: string }>;
  assignee: {
    id: string;
    name: string;
    displayName: string;
    avatarUrl: string | null;
  } | null;
}

export interface GetMyIssuesOptions {
  stateTypes?: string[];
  limit?: number;
}

function manorDataDir(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Manor");
  }
  return path.join(os.homedir(), ".local", "share", "Manor");
}

export class LinearManager {
  private tokenPath: string;

  constructor() {
    this.tokenPath = path.join(manorDataDir(), "linear-token.enc");
  }

  saveToken(apiKey: string): void {
    const encrypted = safeStorage.encryptString(apiKey);
    fs.mkdirSync(path.dirname(this.tokenPath), { recursive: true });
    fs.writeFileSync(this.tokenPath, encrypted);
  }

  getToken(): string | null {
    try {
      const encrypted = fs.readFileSync(this.tokenPath);
      return safeStorage.decryptString(encrypted);
    } catch {
      return null;
    }
  }

  clearToken(): void {
    try {
      fs.unlinkSync(this.tokenPath);
    } catch {
      // file may not exist
    }
  }

  isConnected(): boolean {
    return this.getToken() !== null;
  }

  async getViewer(): Promise<{ name: string; email: string }> {
    const data = await this.graphql<{
      viewer: { name: string; email: string };
    }>(`query { viewer { name email } }`);
    return data.viewer;
  }

  async getTeams(): Promise<LinearTeam[]> {
    const data = await this.graphql<{ teams: { nodes: LinearTeam[] } }>(
      `query { teams { nodes { id name key } } }`,
    );
    return data.teams.nodes;
  }

  async getMyIssues(
    teamIds: string[],
    options?: GetMyIssuesOptions,
  ): Promise<LinearIssue[]> {
    if (teamIds.length === 0) return [];

    const stateTypes = options?.stateTypes ?? ["unstarted"];
    const limit = options?.limit ?? 5;
    const fetchLimit = Math.min(limit * 2, 50); // Fetch extra to allow for sorting/slicing

    type RawIssue = Omit<LinearIssue, "labels"> & {
      labels: { nodes: Array<{ name: string; color: string }> };
    };
    const data = await this.graphql<{
      viewer: {
        assignedIssues: {
          nodes: RawIssue[];
        };
      };
    }>(
      `query($teamIds: [ID!]!, $stateTypes: [String!]!, $first: Int!) {
        viewer {
          assignedIssues(
            filter: {
              team: { id: { in: $teamIds } }
              state: { type: { in: $stateTypes } }
            }
            first: $first
            orderBy: updatedAt
          ) {
            nodes {
              id
              identifier
              title
              url
              branchName
              priority
              state { name type }
              labels { nodes { name color } }
            }
          }
        }
      }`,
      { teamIds, stateTypes, first: fetchLimit },
    );
    // Sort by state type (unstarted/todo first, then backlog), then by priority
    const stateOrder: Record<string, number> = { unstarted: 0, backlog: 1 };
    const issues: LinearIssue[] = data.viewer.assignedIssues.nodes.map(
      (raw) => ({ ...raw, labels: raw.labels.nodes }),
    );
    issues.sort((a, b) => {
      const sa = stateOrder[a.state.type] ?? 2;
      const sb = stateOrder[b.state.type] ?? 2;
      if (sa !== sb) return sa - sb;
      const pa = a.priority || 5;
      const pb = b.priority || 5;
      return pa - pb;
    });
    return issues.slice(0, limit);
  }

  async getAllIssues(
    teamIds: string[],
    options?: GetMyIssuesOptions,
  ): Promise<LinearIssue[]> {
    if (teamIds.length === 0) return [];

    const stateTypes = options?.stateTypes ?? ["unstarted"];
    const limit = options?.limit ?? 50;
    const fetchLimit = Math.min(limit * 2, 50);

    type RawIssue = Omit<LinearIssue, "labels"> & {
      labels: { nodes: Array<{ name: string; color: string }> };
    };
    const data = await this.graphql<{
      issues: {
        nodes: RawIssue[];
      };
    }>(
      `query($teamIds: [ID!]!, $stateTypes: [String!]!, $first: Int!) {
        issues(
          filter: {
            team: { id: { in: $teamIds } }
            state: { type: { in: $stateTypes } }
          }
          first: $first
        ) {
          nodes {
            id
            identifier
            title
            url
            branchName
            priority
            state { name type }
            labels { nodes { name color } }
          }
        }
      }`,
      { teamIds, stateTypes, first: fetchLimit },
    );
    const stateOrder: Record<string, number> = { unstarted: 0, backlog: 1 };
    const issues: LinearIssue[] = data.issues.nodes.map((raw) => ({
      ...raw,
      labels: raw.labels.nodes,
    }));
    issues.sort((a, b) => {
      const sa = stateOrder[a.state.type] ?? 2;
      const sb = stateOrder[b.state.type] ?? 2;
      if (sa !== sb) return sa - sb;
      const pa = a.priority || 5;
      const pb = b.priority || 5;
      return pa - pb;
    });
    return issues.slice(0, limit);
  }

  async getIssueDetail(issueId: string): Promise<LinearIssueDetail> {
    type RawDetail = Omit<LinearIssueDetail, "labels"> & {
      labels: { nodes: Array<{ id: string; name: string; color: string }> };
    };
    const data = await this.graphql<{ issue: RawDetail }>(
      `query($id: String!) {
        issue(id: $id) {
          id
          identifier
          title
          url
          branchName
          priority
          description
          state { name type }
          labels { nodes { id name color } }
          assignee { id name displayName avatarUrl }
        }
      }`,
      { id: issueId },
    );
    const raw = data.issue;
    return { ...raw, labels: raw.labels.nodes };
  }

  async startIssue(issueId: string): Promise<void> {
    try {
      // Get issue's team workflow states and current assignee
      const data = await this.graphql<{
        issue: {
          assignee: { id: string } | null;
          team: {
            states: {
              nodes: Array<{ id: string; name: string; type: string }>;
            };
          };
        };
        viewer: { id: string };
      }>(
        `query($id: String!) {
          issue(id: $id) {
            assignee { id }
            team {
              states { nodes { id name type } }
            }
          }
          viewer { id }
        }`,
        { id: issueId },
      );

      const startedState = data.issue.team.states.nodes.find(
        (s) => s.type === "started",
      );
      if (!startedState) return;

      const input: Record<string, string> = { stateId: startedState.id };
      if (!data.issue.assignee) {
        input.assigneeId = data.viewer.id;
      }

      await this.graphql(
        `mutation($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) { success }
        }`,
        { id: issueId, input },
      );
    } catch {
      // fire-and-forget; failures should not block workspace creation
    }
  }

  autoMatchProjects(
    projects: { id: string; name: string }[],
    teams: LinearTeam[],
  ): Record<string, LinearAssociation> {
    const normalize = (s: string) =>
      s
        .toLowerCase()
        .replace(/-(app|web|api|service)$/i, "")
        .replace(/[^a-z0-9]/g, "");

    const teamMap = new Map<string, LinearTeam>();
    for (const team of teams) {
      teamMap.set(normalize(team.name), team);
    }

    const result: Record<string, LinearAssociation> = {};
    for (const project of projects) {
      const key = normalize(project.name);
      const match = teamMap.get(key);
      if (match) {
        result[project.id] = {
          teamId: match.id,
          teamName: match.name,
          teamKey: match.key,
        };
      }
    }
    return result;
  }

  private async graphql<T>(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<T> {
    const token = this.getToken();
    if (!token) throw new Error("Not connected to Linear");

    const res = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: token,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Linear API error: ${res.status} ${res.statusText} ${body}`,
      );
    }

    const json = (await res.json()) as {
      data?: T;
      errors?: Array<{ message: string }>;
    };
    if (json.errors?.length) {
      throw new Error(json.errors[0].message);
    }
    if (!json.data) {
      throw new Error("No data returned from Linear API");
    }
    return json.data;
  }
}
