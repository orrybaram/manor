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

    const data = await this.graphql<{
      viewer: {
        assignedIssues: {
          nodes: LinearIssue[];
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
            }
          }
        }
      }`,
      { teamIds, stateTypes, first: fetchLimit },
    );
    // Sort by priority (1=urgent, 2=high, 3=medium, 4=low, 0=none)
    const issues = data.viewer.assignedIssues.nodes;
    issues.sort((a, b) => {
      const pa = a.priority || 5;
      const pb = b.priority || 5;
      return pa - pb;
    });
    return issues.slice(0, limit);
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
