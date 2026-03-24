import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface ChecksSummary {
  total: number;
  passing: number;
  failing: number;
  pending: number;
}

interface PrInfo {
  number: number;
  state: string;
  title: string;
  url: string;
  isDraft?: boolean;
  additions?: number;
  deletions?: number;
  reviewDecision?: string | null;
  checks?: ChecksSummary | null;
  unresolvedThreads?: number;
}

export interface GitHubIssue {
  number: number;
  title: string;
  url: string;
  state: string;
  labels: Array<{ name: string; color: string }>;
  assignees: Array<{ login: string }>;
}

export interface GitHubIssueDetail extends GitHubIssue {
  body: string | null;
  milestone: { title: string } | null;
}

export class GitHubManager {
  async getPrForBranch(repoPath: string, branch: string): Promise<PrInfo | null> {
    return this.getPrForBranchInner(repoPath, branch);
  }

  async getPrsForBranches(
    repoPath: string,
    branches: string[],
  ): Promise<[string, PrInfo | null][]> {
    const results = await Promise.allSettled(
      branches.map((branch) =>
        this.getPrForBranchInner(repoPath, branch).then(
          (pr): [string, PrInfo | null] => [branch, pr],
        ),
      ),
    );

    return results.map((result, i) => {
      if (result.status === "fulfilled") return result.value;
      return [branches[i], null];
    });
  }

  private async getPrForBranchInner(repoPath: string, branch: string): Promise<PrInfo | null> {
    try {
      const { stdout } = await execFileAsync(
        "gh",
        ["pr", "list", "--head", branch, "--state", "all", "--json", "number,state,title,url,isDraft,additions,deletions,reviewDecision,statusCheckRollup", "--limit", "1"],
        { cwd: repoPath, encoding: "utf-8", timeout: 10000 },
      );

      const prs = JSON.parse(stdout);
      if (!Array.isArray(prs) || prs.length === 0) return null;

      const pr = prs[0];

      let checks: ChecksSummary | null = null;
      if (Array.isArray(pr.statusCheckRollup) && pr.statusCheckRollup.length > 0) {
        let passing = 0;
        let failing = 0;
        let pending = 0;
        for (const check of pr.statusCheckRollup) {
          const conclusion = check.conclusion as string | null;
          if (conclusion === "SUCCESS") {
            passing++;
          } else if (
            conclusion === "FAILURE" ||
            conclusion === "CANCELLED" ||
            conclusion === "TIMED_OUT"
          ) {
            failing++;
          } else {
            pending++;
          }
        }
        checks = { total: pr.statusCheckRollup.length, passing, failing, pending };
      }

      const unresolvedThreads = await this.getUnresolvedThreadCount(pr.url, pr.number);

      return {
        number: pr.number,
        state: (pr.state as string).toLowerCase(),
        title: pr.title,
        url: pr.url,
        isDraft: pr.isDraft,
        additions: pr.additions,
        deletions: pr.deletions,
        reviewDecision: pr.reviewDecision ?? null,
        checks,
        unresolvedThreads,
      };
    } catch {
      return null;
    }
  }

  private async getUnresolvedThreadCount(prUrl: string, prNumber: number): Promise<number | undefined> {
    try {
      const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\//);
      if (!match) return undefined;
      const [, owner, repo] = match;
      const query = `query { repository(owner: "${owner}", name: "${repo}") { pullRequest(number: ${prNumber}) { reviewThreads(first: 100) { nodes { isResolved } } } } }`;
      const { stdout } = await execFileAsync("gh", ["api", "graphql", "-f", `query=${query}`], {
        encoding: "utf-8",
        timeout: 10000,
      });
      const data = JSON.parse(stdout);
      const threads = data?.data?.repository?.pullRequest?.reviewThreads?.nodes;
      if (!Array.isArray(threads)) return undefined;
      return threads.filter((t: { isResolved: boolean }) => !t.isResolved).length;
    } catch {
      return undefined;
    }
  }

  async getMyIssues(repoPath: string, limit = 50): Promise<GitHubIssue[]> {
    try {
      const { stdout } = await execFileAsync(
        "gh",
        ["issue", "list", "--assignee", "@me", "--state", "open", "--json", "number,title,url,state,labels,assignees", "--limit", String(limit)],
        { cwd: repoPath, encoding: "utf-8", timeout: 10000 },
      );
      return JSON.parse(stdout);
    } catch {
      return [];
    }
  }

  async getAllIssues(repoPath: string, limit = 50): Promise<GitHubIssue[]> {
    try {
      const { stdout } = await execFileAsync(
        "gh",
        ["issue", "list", "--state", "open", "--json", "number,title,url,state,labels,assignees", "--limit", String(limit)],
        { cwd: repoPath, encoding: "utf-8", timeout: 10000 },
      );
      return JSON.parse(stdout);
    } catch {
      return [];
    }
  }

  async getIssueDetail(repoPath: string, issueNumber: number): Promise<GitHubIssueDetail> {
    const { stdout } = await execFileAsync(
      "gh",
      ["issue", "view", String(issueNumber), "--json", "number,title,url,state,body,labels,assignees,milestone"],
      { cwd: repoPath, encoding: "utf-8", timeout: 10000 },
    );
    return JSON.parse(stdout);
  }

  async checkStatus(): Promise<{ installed: boolean; authenticated: boolean; username?: string }> {
    try {
      const { stdout, stderr } = await execFileAsync("gh", ["auth", "status", "--hostname", "github.com"], {
        encoding: "utf-8",
        timeout: 5000,
      });
      // gh auth status outputs to stdout, parse username from "Logged in to github.com account username ..."
      const combined = stdout + stderr;
      const match = combined.match(/account\s+(\S+)/);
      return { installed: true, authenticated: true, username: match?.[1] };
    } catch (err: unknown) {
      const e = err as { stderr?: string; stdout?: string };
      // gh exists but not authenticated → exit code 1
      if (e.stderr?.includes("not logged in") || e.stdout?.includes("not logged in")) {
        return { installed: true, authenticated: false };
      }
      // gh not found → ENOENT
      return { installed: false, authenticated: false };
    }
  }
}
