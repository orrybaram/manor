/**
 * The issue-source seam: one uniform `IssueBackend` per source, so the control
 * server's issue routes never branch on `source === "linear"`. Uniform down to
 * failure modes: every `detail()` validates its own ref shape and throws
 * `InvalidIssueRef`, so a caller's bad ref is a 400 whichever source served it.
 *
 * Main-side and dep-aware — it holds the real GitHubManager/LinearManager. Its
 * counterpart `issue-sources.ts` stays pure (normalization + state vocabulary);
 * this module is where those pure functions meet live managers.
 *
 * Deps are typed against a local `IssueDeps` rather than importing `ControlDeps`
 * from routes/types.ts: the routes import *this* module as a value, so the
 * structural interface keeps the dependency edge one-way. `ControlDeps`
 * satisfies `IssueDeps` structurally.
 */

import type { GitHubManager } from "./github";
import type { LinearManager } from "./linear";
import type { ProjectInfo } from "./persistence";
import {
  linearStateTypes,
  normalizeGitHubIssue,
  normalizeGitHubIssueDetail,
  normalizeLinearIssue,
  normalizeLinearIssueDetail,
} from "./issue-sources";
import type {
  IssueSource,
  IssueState,
  McpIssue,
  McpIssueDetail,
} from "./issue-sources";

/** The slice of `ControlDeps` an issue backend needs. */
export interface IssueDeps {
  githubManager: GitHubManager | null;
  linearManager: LinearManager | null;
}

/** The slice of `ProjectInfo` an issue backend needs. */
export type IssueProject = Pick<ProjectInfo, "path" | "linearAssociations">;

export interface IssueBackend {
  list(
    filter: "all" | "assigned",
    state: IssueState,
    limit: number,
  ): Promise<McpIssue[]>;
  /**
   * Read one issue by the `ref` a prior `list()` emitted — refs round-trip.
   *
   * @throws {InvalidIssueRef} if `ref` is malformed for this source. Every
   * backend validates before reaching out, so a caller's bad ref is a 400 no
   * matter which source it named; only the source itself can produce a 502.
   */
  detail(ref: string): Promise<McpIssueDetail>;
}

/**
 * A ref the caller could never have meant — as opposed to an upstream failure.
 * The routes map this to 400 and everything else to 502.
 */
export class InvalidIssueRef extends Error {}

/** Linear resolves an issue by UUID or by human identifier ("ENG-123"). */
const LINEAR_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LINEAR_IDENTIFIER = /^[A-Z][A-Z0-9]*-\d+$/;

export type IssueBackendResult =
  | { ok: true; backend: IssueBackend }
  | { ok: false; status: number; error: string };

/**
 * Can Linear answer a query for this project *right now*? Two independent
 * conditions, reported separately: a missing connection is a capability gap
 * (503), a project with no team associated is a configuration gap (400).
 *
 * `availableSources` and `issueBackend("linear")` both read this, so the
 * advertised source list and the one that actually serves can never disagree.
 */
function linearReadiness(
  deps: IssueDeps,
  project: IssueProject,
):
  | { ready: true; linear: LinearManager; teamIds: string[] }
  | { ready: false; reason: "not-connected" | "no-team" } {
  const linear = deps.linearManager;
  if (!linear || !linear.isConnected()) {
    return { ready: false, reason: "not-connected" };
  }
  if (project.linearAssociations.length === 0) {
    return { ready: false, reason: "no-team" };
  }
  return {
    ready: true,
    linear,
    teamIds: project.linearAssociations.map((a) => a.teamId),
  };
}

function githubBackend(
  github: GitHubManager,
  project: IssueProject,
): IssueBackend {
  return {
    async list(filter, state, limit) {
      const issues =
        filter === "all"
          ? await github.getAllIssues(project.path, limit, state)
          : await github.getMyIssues(project.path, limit, state);
      return issues.map(normalizeGitHubIssue);
    },
    async detail(ref) {
      // `list()` emits "#42", so accept it back verbatim. `/^\d+$/` rather than
      // `Number.parseInt`, which reads "42abc" as 42 and fetches issue 42.
      const bare = ref.startsWith("#") ? ref.slice(1) : ref;
      if (!/^\d+$/.test(bare) || Number(bare) <= 0) {
        throw new InvalidIssueRef("GitHub issue refs must be numeric.");
      }
      return normalizeGitHubIssueDetail(
        await github.getIssueDetail(project.path, Number(bare)),
      );
    },
  };
}

function linearBackend(linear: LinearManager, teamIds: string[]): IssueBackend {
  return {
    async list(filter, state, limit) {
      const opts = { stateTypes: linearStateTypes(state), limit };
      const issues =
        filter === "all"
          ? await linear.getAllIssues(teamIds, opts)
          : await linear.getMyIssues(teamIds, opts);
      return issues.map(normalizeLinearIssue);
    },
    async detail(ref) {
      // Linear's `issue(id:)` resolves both a UUID and a human identifier
      // ("ENG-123"), so the ref from the listing round-trips verbatim. Reject
      // anything that is neither *here*: left to the SDK, a caller's typo comes
      // back as a transport error and the route calls it a 502.
      if (!LINEAR_UUID.test(ref) && !LINEAR_IDENTIFIER.test(ref)) {
        throw new InvalidIssueRef(
          "Linear issue refs must be an identifier like 'ENG-123' or a UUID.",
        );
      }
      return normalizeLinearIssueDetail(await linear.getIssueDetail(ref));
    },
  };
}

/** Resolve the backend for `source`, or the reason it cannot serve. */
export function issueBackend(
  deps: IssueDeps,
  project: IssueProject,
  source: IssueSource,
): IssueBackendResult {
  if (source === "github") {
    const github = deps.githubManager;
    if (!github) {
      return { ok: false, status: 503, error: "GitHub is not available" };
    }
    return { ok: true, backend: githubBackend(github, project) };
  }

  const readiness = linearReadiness(deps, project);
  if (!readiness.ready) {
    return readiness.reason === "not-connected"
      ? {
          ok: false,
          status: 503,
          error: "Linear is not connected. Connect Linear in Manor settings.",
        }
      : {
          ok: false,
          status: 400,
          error: "Project has no Linear team associated.",
        };
  }
  return {
    ok: true,
    backend: linearBackend(readiness.linear, readiness.teamIds),
  };
}

/**
 * The sources that can answer a query for this project right now. A connected
 * Linear account with no team associated on this project cannot, so it is
 * omitted rather than advertised and then failing at call time.
 */
export function availableSources(
  deps: IssueDeps,
  project: IssueProject,
): IssueSource[] {
  const sources: IssueSource[] = [];
  if (deps.githubManager) sources.push("github");
  if (linearReadiness(deps, project).ready) sources.push("linear");
  return sources;
}
