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
}

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

function answer() {
  const sub = args.slice(0, 2).join(" ");
  if (sub === "auth status") {
    return "Logged in to github.com account tester (keyring)";
  }
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

/**
 * Writes the fake `gh` and its fixtures under `tempHome`, returning the
 * directory to put first on PATH.
 */
export function installFakeGh(tempHome: string, fixtures: FakeGhFixtures): string {
  const binDir = path.join(tempHome, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const fixturesPath = path.join(tempHome, "gh-fixtures.json");
  fs.writeFileSync(
    fixturesPath,
    JSON.stringify({
      prs: Object.fromEntries(
        Object.entries(fixtures.prs).map(([branch, pr]) => [branch, toGraphqlPr(pr)]),
      ),
      conversations: fixtures.conversations ?? {},
      quiet: QUIET_CONVERSATION,
    }),
  );
  // The test runner's own node, so the fake works whatever PATH the app has.
  fs.writeFileSync(
    path.join(binDir, "gh"),
    `#!${process.execPath}\nconst FIXTURES = ${JSON.stringify(fixturesPath)};\n${SCRIPT}`,
    { mode: 0o755 },
  );
  return binDir;
}
