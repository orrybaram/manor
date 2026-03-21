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
      };
    } catch {
      return null;
    }
  }
}
