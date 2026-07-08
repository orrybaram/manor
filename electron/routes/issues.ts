/**
 * `/projects/:projectId/issues` and `…/issues/:issueRef` — thin HTTP over the
 * `IssueBackend` seam, which is what keeps these two handlers from branching on
 * `source === "linear"`.
 */

import { isIssueSource, parseIssueState } from "../issue-sources";
import type { IssueSource } from "../issue-sources";
import { InvalidIssueRef, issueBackend } from "../issue-backends";
import { withProject } from "./projects";
import type { Route } from "./types";

/**
 * Read `?source=` off an issue route. Absent means GitHub, so existing callers
 * that predate Linear support keep working untouched.
 */
function parseSource(
  url: URL,
): { ok: true; source: IssueSource } | { ok: false; error: string } {
  const raw = url.searchParams.get("source");
  if (raw === null) return { ok: true, source: "github" };
  if (isIssueSource(raw)) return { ok: true, source: raw };
  return {
    ok: false,
    error: `Unknown source '${raw}'. Use 'github' or 'linear'.`,
  };
}

export const issueRoutes: Route[] = [
  {
    method: "GET",
    path: "/projects/:projectId/issues",
    handler: withProject(async ({ deps, url, json }, _pm, project) => {
      const parsed = parseSource(url);
      if (!parsed.ok) {
        json(400, { error: parsed.error });
        return;
      }
      const filter =
        url.searchParams.get("filter") === "all" ? "all" : "assigned";
      const state = parseIssueState(url.searchParams.get("state"));
      const limitParam = parseInt(url.searchParams.get("limit") ?? "", 10);
      const limit =
        Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 50;

      const chosen = await issueBackend(deps, project, parsed.source);
      if (!chosen.ok) {
        json(chosen.status, { error: chosen.error });
        return;
      }
      // An issue source is an upstream service: a throw here (expired Linear
      // token, `gh` blowing up) is a bad gateway, not a Manor bug.
      try {
        json(200, await chosen.backend.list(filter, state, limit));
      } catch (err) {
        json(502, { error: String(err) });
      }
    }),
  },

  {
    method: "GET",
    path: "/projects/:projectId/issues/:issueRef",
    handler: withProject(async ({ deps, params, url, json }, _pm, project) => {
      const parsed = parseSource(url);
      if (!parsed.ok) {
        json(400, { error: parsed.error });
        return;
      }

      const chosen = await issueBackend(deps, project, parsed.source);
      if (!chosen.ok) {
        json(chosen.status, { error: chosen.error });
        return;
      }
      try {
        json(200, await chosen.backend.detail(params.issueRef));
      } catch (err) {
        // A ref the source could never accept is the caller's fault (400); a
        // throw from the source itself is the source's (502). `err.message`, not
        // `String(err)`, so the 400 body stays the bare sentence it always was.
        if (err instanceof InvalidIssueRef) json(400, { error: err.message });
        else json(502, { error: String(err) });
      }
    }),
  },
];
