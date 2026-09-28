/**
 * The New Workspace dialog's decisions, kept DOM-free so the project-store
 * tests drive them directly: the project select's options, the branch lists
 * it offers, and, for a linked group (ADR-192), the base branch after a host
 * change and whether the chosen branch exists on the chosen host.
 */

/** What these helpers need of a project. */
interface DialogProject {
  id: string;
  name: string;
  defaultBranch: string;
  group?: { id: string; name: string; memberIds: readonly string[] } | null;
}

/**
 * A project select value. A group and a project are kept apart by a prefix,
 * so a value never depends on which kind of id happens to match first.
 */
type ProjectSelectValue = `project:${string}` | `group:${string}`;

/** The select value for `project`: its group's when it is linked. */
export function projectSelectValue(project: DialogProject): ProjectSelectValue {
  return project.group ? `group:${project.group.id}` : `project:${project.id}`;
}

/** The project select's options: a linked group is one option, named after the group. */
export function projectSelectOptions(
  projects: readonly DialogProject[],
): { value: ProjectSelectValue; label: string }[] {
  const options: { value: ProjectSelectValue; label: string }[] = [];
  const seen = new Set<string>();
  for (const p of projects) {
    const value = projectSelectValue(p);
    if (seen.has(value)) continue;
    seen.add(value);
    options.push({ value, label: p.group?.name ?? p.name });
  }
  return options;
}

/**
 * The project a select value stands for: the project itself, or a group's
 * first member in the list. The host picker then chooses among the members.
 */
export function projectForSelectValue(
  value: string,
  projects: readonly DialogProject[],
): string | undefined {
  if (value.startsWith("project:")) {
    const id = value.slice("project:".length);
    return projects.find((p) => p.id === id)?.id;
  }
  if (value.startsWith("group:")) {
    const id = value.slice("group:".length);
    return projects.find((p) => p.group?.id === id)?.id;
  }
  return undefined;
}

/**
 * Base branches for a new branch: the default branch, then its origin
 * counterpart, then every other remote branch.
 */
export function baseBranchOptions(
  defaultBranch: string,
  remoteBranches: readonly string[],
): string[] {
  return [
    defaultBranch,
    `origin/${defaultBranch}`,
    ...remoteBranches.filter((b) => b !== defaultBranch).map((b) => `origin/${b}`),
  ];
}

/**
 * Branches to check out as they are: those both local and on origin, then
 * local-only ones, then remote-only ones. The default branch is left out.
 */
export function existingBranchOptions(
  defaultBranch: string,
  localBranches: readonly string[],
  remoteBranches: readonly string[],
): string[] {
  const remoteSet = new Set(remoteBranches);
  const localSet = new Set(localBranches);
  const both = localBranches.filter((b) => b !== defaultBranch && remoteSet.has(b));
  const localOnly = localBranches.filter((b) => b !== defaultBranch && !remoteSet.has(b));
  const remoteOnly = remoteBranches.filter((b) => b !== defaultBranch && !localSet.has(b));
  return [...both, ...localOnly, ...remoteOnly];
}

/**
 * The base branch after the host picker moves to `member`. It becomes the
 * member's own default branch, unless the user picked a base themselves.
 * Members of one repo can still differ, `main` on one and `master` on another.
 */
export function reseedBaseBranch(
  current: string,
  edited: boolean,
  member: Pick<DialogProject, "defaultBranch">,
): string {
  return edited ? current : member.defaultBranch;
}

export type BranchOnHost =
  | { state: "ok" }
  /** The chosen host's branch lists haven't come in; Create waits for them. */
  | { state: "pending" }
  | { state: "missing"; message: string };

/**
 * Whether a linked member's host has the branch a workspace would use
 * (ADR-192). A branch picked before switching hosts may exist only on the
 * other host, and it must be pushed first. `localBranches` and
 * `remoteBranches` are undefined until they load. The remote list is
 * fetched first, so it shows what origin has now.
 *
 * A new branch based on the default branch is always fine. That covers an
 * empty remote list (no origin, or a fetch that failed). Anything else is
 * judged against the lists, and waits for them.
 */
export function checkBranchOnHost(input: {
  mode: "new" | "existing";
  branch: string;
  defaultBranch: string;
  localBranches: readonly string[] | undefined;
  remoteBranches: readonly string[] | undefined;
  hostName: string;
}): BranchOnHost {
  const { mode, branch, defaultBranch, localBranches, remoteBranches, hostName } = input;
  if (!branch) return { state: "ok" };
  if (mode === "new" && (branch === defaultBranch || branch === `origin/${defaultBranch}`)) {
    return { state: "ok" };
  }
  if (!localBranches || !remoteBranches) return { state: "pending" };
  const options =
    mode === "new"
      ? baseBranchOptions(defaultBranch, remoteBranches)
      : existingBranchOptions(defaultBranch, localBranches, remoteBranches);
  if (options.includes(branch)) return { state: "ok" };
  return {
    state: "missing",
    message: `"${branch}" isn't on ${hostName}. Push it to origin first, then create the workspace there.`,
  };
}
