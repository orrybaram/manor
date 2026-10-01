/**
 * The GraphQL behind PR polling (#303): building the batched `gh api graphql`
 * calls and flattening what comes back. `GitHubManager` decides what to ask
 * and caches the answers; this module only knows the query shapes.
 */

/** How many comments and reviews to ask GitHub for. */
const RECENT_COMMENT_FETCH = 20;

/**
 * `gh pr list --json statusCheckRollup` returns a union: check runs carry
 * `name`/`conclusion`/`detailsUrl`, legacy status contexts carry
 * `context`/`state`/`targetUrl`. Both shapes are flattened here.
 */
export interface RawStatusCheck {
  name?: string;
  context?: string;
  conclusion?: string | null;
  state?: string | null;
  detailsUrl?: string;
  targetUrl?: string;
  workflowName?: string;
  /** Check runs: when it started; null while still queued. */
  startedAt?: string | null;
  /** Status contexts: when it was posted. */
  createdAt?: string | null;
}

/** One PR as the batched branch query returns it, its rollup flattened. */
export interface RawPr {
  number: number;
  state: string;
  title: string;
  url: string;
  isDraft: boolean;
  additions: number;
  deletions: number;
  reviewDecision: string | null;
  updatedAt: string;
  mergeable: string;
  autoMergeRequest: unknown;
  statusCheckRollup: RawStatusCheck[];
}

/**
 * `gh api graphql` takes no `--repo`: for a checkout `gh` cannot run inside
 * (`repoArgs` names its repo), the `{owner}`/`{repo}` placeholders are read
 * from `GH_REPO`, and a host other than github.com goes in `--hostname`.
 * A local checkout needs neither: the placeholders come from its directory.
 */
export function graphqlTarget(repoArgs: string[]): {
  args: string[];
  env: NodeJS.ProcessEnv | undefined;
} {
  const at = repoArgs.indexOf("--repo");
  const repo = at >= 0 ? repoArgs[at + 1] : undefined;
  if (!repo) return { args: [], env: undefined };
  const segments = repo.split("/");
  return {
    args: segments.length === 3 ? ["--hostname", segments[0]] : [],
    env: { ...process.env, GH_REPO: repo },
  };
}

/** The `gh pr list --json` fields the badge used, as GraphQL. */
const PR_FIELDS =
  "number state title url isDraft additions deletions reviewDecision updatedAt mergeable " +
  "autoMergeRequest { enabledAt } " +
  "commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes { " +
  "__typename " +
  "... on CheckRun { name conclusion status detailsUrl startedAt checkSuite { workflowRun { workflow { name } } } } " +
  "... on StatusContext { context state targetUrl createdAt } " +
  "} } } } } }";

/**
 * `gh api graphql` arguments asking for each branch's newest PR (any state,
 * newest created first, as `gh pr list --head` does), aliased `b<i>`. Branch
 * names go in as variables, so none needs escaping.
 */
export function prsQueryArgs(branches: string[]): string[] {
  const vars = branches.map((_, i) => `$h${i}: String!`).join(", ");
  const aliases = branches
    .map(
      (_, i) =>
        `b${i}: pullRequests(headRefName: $h${i}, first: 1, ` +
        `orderBy: { field: CREATED_AT, direction: DESC }) { nodes { ${PR_FIELDS} } }`,
    )
    .join(" ");
  const query =
    `query($owner: String!, $name: String!, ${vars}) ` +
    `{ repository(owner: $owner, name: $name) { ${aliases} } }`;
  return [
    "-F",
    "owner={owner}",
    "-F",
    "name={repo}",
    ...branches.flatMap((branch, i) => ["-f", `h${i}=${branch}`]),
    "-f",
    `query=${query}`,
  ];
}

/** A `pullRequests` node, with its last commit's rollup flattened as `gh` does. */
export function normalizeRawPr(node: Record<string, unknown>): RawPr {
  type Context = RawStatusCheck & {
    checkSuite?: { workflowRun?: { workflow?: { name?: string } | null } | null } | null;
  };
  const commits = node.commits as
    | { nodes?: Array<{ commit?: { statusCheckRollup?: { contexts?: { nodes?: Context[] } } | null } }> }
    | undefined;
  const contexts = commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
  const statusCheckRollup = contexts.map(({ checkSuite, ...check }) => {
    const workflowName = checkSuite?.workflowRun?.workflow?.name;
    return workflowName ? { ...check, workflowName } : check;
  });
  return { ...(node as unknown as RawPr), statusCheckRollup };
}

// The newest entries of all three conversation surfaces: enough for the PR
// popover's comment list, and the newest of them is what a "new comment"
// notification carries (#177). `viewer` and `__typename` ride along so every
// entry can be tagged with who wrote it — you, or a GitHub App — which is
// what the comment notification filters gate on.
const CONVERSATION_FIELDS = `isInMergeQueue reviewThreads(first: 100) { nodes { isResolved isOutdated path comments(first: 1) { nodes { author { __typename login } body url createdAt } } } } comments(last: ${RECENT_COMMENT_FETCH}) { totalCount nodes { author { __typename login } body url createdAt } } reviews(last: ${RECENT_COMMENT_FETCH}) { totalCount nodes { author { __typename login } body url submittedAt state } }`;

/** PRs of one github.com repo, for `conversationsQueryArgs`. */
export interface RepoPrNumbers {
  owner: string;
  name: string;
  numbers: number[];
}

/**
 * `gh api graphql` arguments asking for the conversation of every PR, the
 * repos aliased `r<i>` and their PRs `p<j>`, with `viewer { login }`. Owners
 * and names go in as variables, like `prsQueryArgs`' branches.
 */
export function conversationsQueryArgs(repos: RepoPrNumbers[]): string[] {
  const vars = repos.map((_, r) => `$o${r}: String!, $n${r}: String!`).join(", ");
  const aliases = repos
    .map(({ numbers }, r) => {
      const pulls = numbers
        .map((n, p) => `p${p}: pullRequest(number: ${Number(n)}) { ${CONVERSATION_FIELDS} }`)
        .join(" ");
      return `r${r}: repository(owner: $o${r}, name: $n${r}) { ${pulls} }`;
    })
    .join(" ");
  return [
    ...repos.flatMap(({ owner, name }, r) => ["-f", `o${r}=${owner}`, "-f", `n${r}=${name}`]),
    "-f",
    `query=query(${vars}) { viewer { login } ${aliases} }`,
  ];
}
