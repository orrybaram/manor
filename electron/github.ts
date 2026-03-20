import { execSync } from "node:child_process";

interface PrInfo {
  number: number;
  state: string;
  title: string;
  url: string;
}

export class GitHubManager {
  getPrForBranch(repoPath: string, branch: string): PrInfo | null {
    return this.getPrForBranchInner(repoPath, branch);
  }

  getPrsForBranches(
    repoPath: string,
    branches: string[],
  ): [string, PrInfo | null][] {
    return branches.map((branch) => [
      branch,
      this.getPrForBranchInner(repoPath, branch),
    ]);
  }

  private getPrForBranchInner(repoPath: string, branch: string): PrInfo | null {
    try {
      const output = execSync(
        `gh pr list --head ${JSON.stringify(branch)} --state all --json number,state,title,url --limit 1`,
        { cwd: repoPath, encoding: "utf-8", timeout: 10000 },
      );

      const prs = JSON.parse(output);
      if (!Array.isArray(prs) || prs.length === 0) return null;

      const pr = prs[0];
      return {
        number: pr.number,
        state: (pr.state as string).toLowerCase(),
        title: pr.title,
        url: pr.url,
      };
    } catch {
      return null;
    }
  }
}
