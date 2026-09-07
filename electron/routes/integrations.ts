/**
 * `/linear/*`, `/github/*`, and `POST /projects/:projectId/issues` — the
 * issue-tracker actions that write (ADR-171). The read side already lives in
 * `./issues.ts` behind the `IssueBackend` seam; these three are
 * source-specific by nature, so they name their manager directly the way
 * `../ipc/integrations.ts` does.
 *
 * Linear and GitHub are upstream services: a throw from either is a `502`,
 * not a Manor bug, matching `./issues.ts`.
 */

import { withProject } from "./projects";
import type { Route } from "./types";

export const integrationRoutes: Route[] = [
  {
    method: "POST",
    path: "/linear/issues/:id/start",
    async handler({ deps, params, json }) {
      if (!deps.linearManager) {
        json(503, { error: "Linear is not available" });
        return;
      }
      try {
        await deps.linearManager.startIssue(params.id);
        json(200, { ok: true });
      } catch (err) {
        json(502, { error: String(err) });
      }
    },
  },

  {
    method: "POST",
    path: "/linear/issues/:id/close",
    async handler({ deps, params, json }) {
      if (!deps.linearManager) {
        json(503, { error: "Linear is not available" });
        return;
      }
      try {
        await deps.linearManager.closeIssue(params.id);
        json(200, { ok: true });
      } catch (err) {
        json(502, { error: String(err) });
      }
    },
  },

  {
    method: "GET",
    path: "/github/status",
    async handler({ deps, json }) {
      if (!deps.githubManager) {
        json(503, { error: "GitHub is not available" });
        return;
      }
      try {
        json(200, await deps.githubManager.checkStatus());
      } catch (err) {
        json(502, { error: String(err) });
      }
    },
  },

  {
    // Shares its path with `GET /projects/:projectId/issues` (`./issues.ts`),
    // which lists them. The project supplies the repo: `createIssue` runs `gh`
    // inside `project.path` rather than against a repo the caller names, so an
    // issue can only ever land on a repo Manor already tracks.
    method: "POST",
    path: "/projects/:projectId/issues",
    handler: withProject(async ({ deps, json, readBody }, _pm, project) => {
      if (!deps.githubManager) {
        json(503, { error: "GitHub is not available" });
        return;
      }
      const body = await readBody();
      const title = body.title;
      if (typeof title !== "string" || !title.trim()) {
        json(400, { error: "Missing 'title' string in request body" });
        return;
      }
      const issueBody = body.body ?? "";
      if (typeof issueBody !== "string") {
        json(400, { error: "'body' must be a string" });
        return;
      }
      const labels = body.labels;
      if (
        labels !== undefined &&
        (!Array.isArray(labels) || !labels.every((l) => typeof l === "string"))
      ) {
        json(400, { error: "'labels' must be an array of strings" });
        return;
      }
      try {
        const created = await deps.githubManager.createIssue(
          title,
          issueBody,
          (labels as string[]) ?? [],
          project.path,
        );
        // `createIssue` swallows `gh`'s error and returns null — all this side
        // knows is that it did not happen.
        if (!created) {
          json(502, { error: "gh could not create the issue" });
          return;
        }
        json(200, created);
      } catch (err) {
        json(502, { error: String(err) });
      }
    }),
  },
];
