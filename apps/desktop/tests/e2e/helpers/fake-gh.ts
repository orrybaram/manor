import fs from "fs";
import path from "path";

/**
 * A fake `gh` for specs that drive the real PR poller (#303 batching).
 *
 * The poller asks two batched `gh api graphql` questions: each branch's
 * newest PR (aliases `b<i>`, branch names as `-f h<i>=…`), then every PR's
 * conversation (`r<i>: repository … { p<j>: pullRequest(number: N) … }`).
 * This answers both from fixtures keyed by branch and PR number, so specs
 * describe PRs in `gh pr list --json` shape and never touch GraphQL.
 */

/** One check as `gh pr list --json statusCheckRollup` flattens it. */
export interface FakeCheck {
  name?: string;
  context?: string;
  conclusion?: string | null;
  status?: string;
  state?: string | null;
  workflowName?: string;
}

/** A PR as `gh pr list --json` returns it. */
export interface FakePr {
  number: number;
  state: string;
  title: string;
  url: string;
  isDraft: boolean;
  additions: number;
  deletions: number;
  reviewDecision: string | null;
  updatedAt: string;
  autoMergeRequest: unknown;
  statusCheckRollup: FakeCheck[];
  mergeable?: string;
}

export interface FakeGhFixtures {
  /** Newest PR of each branch; a branch not listed has none. */
  prs: Record<string, FakePr>;
  /** `pullRequest` conversation nodes by PR number; missing means quiet. */
  conversations?: Record<number, unknown>;
  /**
   * The repo's merge settings, as the PR card asks for them. Absent: squash,
   * merge and rebase all allowed, squash the default, no auto-merge.
   */
  repo?: FakeRepoSettings;
  /** PR numbers whose base branch has a merge queue. */
  mergeQueue?: number[];
  /** `gh run view --job <id> --log-failed` output by job id. */
  jobLogs?: Record<string, string>;
}

export interface FakeRepoSettings {
  viewerDefaultMergeMethod: "SQUASH" | "MERGE" | "REBASE";
  squashMergeAllowed: boolean;
  mergeCommitAllowed: boolean;
  rebaseMergeAllowed: boolean;
  autoMergeAllowed: boolean;
}

const DEFAULT_REPO: FakeRepoSettings = {
  viewerDefaultMergeMethod: "SQUASH",
  squashMergeAllowed: true,
  mergeCommitAllowed: true,
  rebaseMergeAllowed: true,
  autoMergeAllowed: false,
};

/** Back to the GraphQL node shape that `normalizeRawPr` flattens. */
function toGraphqlPr({ statusCheckRollup, ...pr }: FakePr): unknown {
  const nodes = statusCheckRollup.map(({ workflowName, ...check }) => ({
    __typename: check.context ? "StatusContext" : "CheckRun",
    ...check,
    ...(workflowName
      ? { checkSuite: { workflowRun: { workflow: { name: workflowName } } } }
      : {}),
  }));
  return {
    mergeable: "MERGEABLE",
    ...pr,
    commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes } } } }] },
  };
}

const QUIET_CONVERSATION = {
  isInMergeQueue: false,
  reviewThreads: { nodes: [] },
  comments: { totalCount: 0, nodes: [] },
  reviews: { totalCount: 0, nodes: [] },
};

// Answers by returning, never `process.exit()`: stdout to a pipe is written
// asynchronously, and exiting early truncates a large reply mid-JSON.
const SCRIPT = String.raw`
const fs = require("fs");
const fix = JSON.parse(fs.readFileSync(FIXTURES, "utf-8"));
const args = process.argv.slice(2);
// Every call, one per line, for specs to assert what Manor asked.
fs.appendFileSync(FIXTURES + ".calls", args.join(" ") + "\n");

function prByNumber(n) {
  return Object.values(fix.prs).find((pr) => pr.number === n);
}

function answer() {
  const sub = args.slice(0, 2).join(" ");
  // A merge lands the PR, queues it, or arms auto-merge, and the next poll
  // sees it: the fixtures file is the fake GitHub's state.
  if (sub === "pr merge") {
    const pr = prByNumber(Number(args[2]));
    if (!pr) return null;
    if (fix.mergeQueue.includes(pr.number)) pr.isInMergeQueue = true;
    else if (args.includes("--auto")) pr.autoMergeRequest = { enabledAt: "2026-10-30T12:00:00Z" };
    else pr.state = "MERGED";
    fs.writeFileSync(FIXTURES, JSON.stringify(fix));
    return "";
  }
  if (sub === "run view") {
    const job = args[args.indexOf("--job") + 1];
    return fix.jobLogs[job] ?? null;
  }
  if (sub === "auth status") {
    return "Logged in to github.com account tester (keyring)";
  }
  // The empty-state probe ("any issue assigned to me?") finds none.
  if (sub === "issue list") return "[]";
  if (sub !== "api graphql") return null;
  const fields = {};
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === "-f" || args[i] === "-F") {
      const at = args[i + 1].indexOf("=");
      fields[args[i + 1].slice(0, at)] = args[i + 1].slice(at + 1);
    }
  }
  if ("h0" in fields) {
    const repository = {};
    for (let i = 0; "h" + i in fields; i++) {
      const pr = fix.prs[fields["h" + i]];
      repository["b" + i] = { nodes: pr ? [pr] : [] };
    }
    return JSON.stringify({ data: { repository } });
  }
  if ("o0" in fields) {
    const data = { viewer: { login: "tester" } };
    for (const block of (fields.query || "").split(/(?=\br\d+: repository\()/).slice(1)) {
      const repo = (data["r" + block.match(/^r(\d+):/)[1]] = {});
      for (const m of block.matchAll(/\bp(\d+): pullRequest\(number: (\d+)\)/g)) {
        repo["p" + m[1]] = fix.conversations[m[2]] || fix.quiet;
      }
    }
    return JSON.stringify({ data });
  }
  const query = fields.query || "";
  const number = Number(fields.number);
  if (query.includes("viewerDefaultMergeMethod")) {
    const repository = { ...fix.repo, pullRequest: { isMergeQueueEnabled: fix.mergeQueue.includes(number) } };
    return JSON.stringify({ data: { repository } });
  }
  const pr = prByNumber(number);
  if (!pr) return null;
  if (query.includes("reviewThreads")) {
    const threads = (fix.conversations[number] || fix.quiet).reviewThreads;
    return JSON.stringify({ data: { repository: { pullRequest: { ...pr, reviewThreads: threads } } } });
  }
  if (query.includes("autoMergeRequest")) {
    return JSON.stringify({ data: { repository: { pullRequest: pr } } });
  }
  return null;
}

const reply = answer();
if (reply === null) {
  process.stderr.write("fake gh: unsupported: " + args.join(" ") + "\n");
  process.exitCode = 1;
} else {
  process.stdout.write(reply + "\n");
}
`;

/** The fixtures file's JSON, in the shape the fake `gh` script reads. */
export function fakeGhFixturesJson(fixtures: FakeGhFixtures): string {
  return JSON.stringify({
    prs: Object.fromEntries(
      Object.entries(fixtures.prs).map(([branch, pr]) => [branch, toGraphqlPr(pr)]),
    ),
    conversations: fixtures.conversations ?? {},
    quiet: QUIET_CONVERSATION,
    repo: fixtures.repo ?? DEFAULT_REPO,
    mergeQueue: fixtures.mergeQueue ?? [],
    jobLogs: fixtures.jobLogs ?? {},
  });
}

/**
 * The fake `gh` as an executable script, reading its fixtures from the
 * JavaScript expression `fixturesPath` (a string literal, or code that
 * computes a path), under the interpreter `shebang`.
 */
export function fakeGhScript(shebang: string, fixturesPath: string): string {
  return `#!${shebang}\nconst FIXTURES = ${fixturesPath};\n${SCRIPT}`;
}

/**
 * Writes the fake `gh` and its fixtures under `tempHome`, returning the
 * directory to put first on PATH.
 */
export function installFakeGh(tempHome: string, fixtures: FakeGhFixtures): string {
  const binDir = path.join(tempHome, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const fixturesPath = fixturesPathIn(tempHome);
  fs.writeFileSync(fixturesPath, fakeGhFixturesJson(fixtures));
  // The test runner's own node, so the fake works whatever PATH the app has.
  fs.writeFileSync(
    path.join(binDir, "gh"),
    fakeGhScript(process.execPath, JSON.stringify(fixturesPath)),
    { mode: 0o755 },
  );
  return binDir;
}

/** Where `installFakeGh` keeps the fixtures; the fake rewrites it on a merge. */
function fixturesPathIn(tempHome: string): string {
  return path.join(tempHome, "gh-fixtures.json");
}

/**
 * Change one PR in place, as GitHub would between polls (a check going
 * green, a queue landing a PR). `edit` gets the GraphQL-shaped node.
 */
export function editFakePr(
  tempHome: string,
  number: number,
  edit: (pr: Record<string, unknown>) => void,
): void {
  const file = fixturesPathIn(tempHome);
  const fix = JSON.parse(fs.readFileSync(file, "utf-8"));
  const pr = Object.values(fix.prs as Record<string, Record<string, unknown>>).find(
    (p) => p.number === number,
  );
  if (!pr) throw new Error(`fake gh: no PR #${number}`);
  edit(pr);
  fs.writeFileSync(file, JSON.stringify(fix));
}

/** Every `gh` invocation so far, one argument string per call. */
export function fakeGhCalls(tempHome: string): string[] {
  const file = `${fixturesPathIn(tempHome)}.calls`;
  return fs.existsSync(file) ? fs.readFileSync(file, "utf-8").split("\n").filter(Boolean) : [];
}
