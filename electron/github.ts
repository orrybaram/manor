import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface PrInfo {
  number: number;
  state: string;
  title: string;
  url: string;
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
        ["pr", "list", "--head", branch, "--state", "all", "--json", "number,state,title,url", "--limit", "1"],
        { cwd: repoPath, encoding: "utf-8", timeout: 10000 },
      );

      const prs = JSON.parse(stdout);
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
