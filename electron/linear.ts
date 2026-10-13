import fs from "node:fs";

import { linearTokenFile } from "./paths";
import type { SecretBox } from "./platform/secret-box";
import { readSealed, writeSealed } from "./platform/sealed-store";
import { isLinearImageUrl } from "../src/lib/task-images";
import { fetchImageDataUrl } from "./image-proxy";

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
  priorityLabel?: string;
  state: { name: string; type: string; color?: string };
  labels: Array<{ name: string; color: string }>;
  updatedAt: string;
  createdAt?: string;
  dueDate?: string | null;
  estimate?: number | null;
  assignee?: { name: string; displayName?: string } | null;
  project?: { name: string } | null;
  cycle?: { number: number; name?: string | null } | null;
  team?: { key: string; name: string } | null;
  creator?: { name: string; displayName?: string } | null;
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

export class LinearManager {
  private tokenPath: string;
  /** The decrypted key, loaded by `init()` so `getToken()` can stay synchronous. */
  private token: string | null = null;

  constructor(private readonly secretBox: SecretBox) {
    this.tokenPath = linearTokenFile();
  }

  /**
   * Decrypt the stored key into memory. Call once before using the manager.
   * A key that cannot be read is treated as disconnected; nothing is written
   * over it until the user saves a new one.
   */
  async init(): Promise<void> {
    try {
      this.token = await readSealed(this.secretBox, this.tokenPath);
    } catch (err) {
      console.warn("[linear] could not read the stored API key:", err);
      this.token = null;
    }
  }

  async saveToken(apiKey: string): Promise<void> {
    await writeSealed(this.secretBox, this.tokenPath, apiKey);
    this.token = apiKey;
  }

  getToken(): string | null {
    return this.token;
  }

  clearToken(): void {
    this.token = null;
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
              priorityLabel
              state { name type color }
              updatedAt
              createdAt
              dueDate
              estimate
              assignee { name displayName }
              creator { name displayName }
              project { name }
              cycle { number name }
              team { key name }
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
            priorityLabel
            state { name type color }
            updatedAt
            createdAt
            dueDate
            estimate
            assignee { name displayName }
            creator { name displayName }
            project { name }
            cycle { number name }
            team { key name }
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
          updatedAt
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

      const startedStates = data.issue.team.states.nodes.filter(
        (s) => s.type === "started",
      );
      const startedState =
        startedStates.find((s) => s.name === "In Progress") ??
        startedStates[0];
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

  async closeIssue(issueId: string): Promise<void> {
    try {
      const data = await this.graphql<{
        issue: {
          team: {
            states: {
              nodes: Array<{ id: string; name: string; type: string }>;
            };
          };
        };
      }>(
        `query($id: String!) {
          issue(id: $id) {
            team {
              states { nodes { id name type } }
            }
          }
        }`,
        { id: issueId },
      );

      const completedStates = data.issue.team.states.nodes.filter(
        (s) => s.type === "completed",
      );
      const doneState =
        completedStates.find((s) => s.name === "Done") ??
        completedStates[0];
      if (!doneState) return;

      await this.graphql(
        `mutation($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) { success }
        }`,
        { id: issueId, input: { stateId: doneState.id } },
      );
    } catch {
      // TODO(ADR-152): this swallows symmetrically with the pre-fix
      // github.ts#closeIssue — fixing GitHubManager without fixing this
      // leaves the same "UI says closed, issue is not" bug for Linear.
      // Left as-is; see ticket 9 of ADR-152 for the GitHub-side fix.
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

  /**
   * Fetch a Linear upload with the stored token and hand back a data URL.
   * Only `uploads.linear.app` gets the token, on every redirect hop; any
   * other host throws and the renderer loads it directly.
   */
  async proxyImage(url: string): Promise<string> {
    if (!isLinearImageUrl(url)) throw new Error("Not a Linear-hosted image");
    const token = this.getToken();
    if (!token) throw new Error("Not connected to Linear");

    return fetchImageDataUrl({
      url,
      authorization: token,
      isTrusted: (hop) => isLinearImageUrl(hop.href),
    });
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
