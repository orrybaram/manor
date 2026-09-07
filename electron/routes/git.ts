/**
 * `/git/*` — thin wrappers over `backend.git` (`GitBackend`,
 * `../backend/types.ts`): stage/unstage/discard/stash, commit, push, staged
 * files, and local/full diff.
 *
 * Every handler takes `cwd` (body for `POST`, query for `GET`) and refuses to
 * run git anywhere that isn't a known workspace path of some project — the
 * only guard here against shelling out into arbitrary directories. `cwd` is
 * matched with `matchProjectByPath` (`../pane-context.ts`), the same lookup
 * `GET /context` uses, so a path nested inside a workspace (not just its
 * root) still resolves.
 */

import { matchProjectByPath } from "../pane-context";
import type { ProjectInfo } from "../persistence";
import type { GitBackend } from "../backend/types";
import type { ControlDeps, Json, Route } from "./types";

const PUSH_TIMEOUT_MS = 5 * 60 * 1000;

interface GitContext {
  git: GitBackend;
  project: ProjectInfo;
  cwd: string;
}

/**
 * Shared preamble every route below runs first: no backend or no project
 * manager is a capability gap (503); a `cwd` that isn't a string, or doesn't
 * match a known workspace, is the caller's mistake (400).
 */
async function resolveGit(
  deps: ControlDeps,
  cwd: unknown,
  json: Json,
): Promise<GitContext | null> {
  if (!deps.backend) {
    json(503, { error: "Git backend is not available" });
    return null;
  }
  if (!deps.projectManager) {
    json(503, { error: "Project management is not available" });
    return null;
  }
  if (typeof cwd !== "string" || !cwd) {
    json(400, { error: "Missing 'cwd' string" });
    return null;
  }
  const projects = await deps.projectManager.getProjects();
  const match = matchProjectByPath(projects, cwd);
  if (!match) {
    json(400, { error: `'${cwd}' is not a known workspace path` });
    return null;
  }
  return { git: deps.backend.git, project: match.project, cwd };
}

/** `files` must be a non-empty array of strings, shared by four routes below. */
function parseFiles(
  body: Record<string, unknown>,
  json: Json,
): string[] | null {
  const files = body.files;
  if (
    !Array.isArray(files) ||
    files.length === 0 ||
    !files.every((f) => typeof f === "string")
  ) {
    json(400, {
      error: "Missing non-empty 'files' array of strings in request body",
    });
    return null;
  }
  return files as string[];
}

export const gitRoutes: Route[] = [
  {
    method: "POST",
    path: "/git/stage",
    async handler({ deps, json, readBody }) {
      const body = await readBody();
      const ctx = await resolveGit(deps, body.cwd, json);
      if (!ctx) return;
      const files = parseFiles(body, json);
      if (!files) return;
      await ctx.git.stage(ctx.cwd, files);
      json(200, { ok: true });
    },
  },

  {
    method: "POST",
    path: "/git/unstage",
    async handler({ deps, json, readBody }) {
      const body = await readBody();
      const ctx = await resolveGit(deps, body.cwd, json);
      if (!ctx) return;
      const files = parseFiles(body, json);
      if (!files) return;
      await ctx.git.unstage(ctx.cwd, files);
      json(200, { ok: true });
    },
  },

  {
    // Destructive: discards uncommitted changes to the given files.
    method: "POST",
    path: "/git/discard",
    async handler({ deps, json, readBody }) {
      const body = await readBody();
      const ctx = await resolveGit(deps, body.cwd, json);
      if (!ctx) return;
      const files = parseFiles(body, json);
      if (!files) return;
      await ctx.git.discard(ctx.cwd, files);
      json(200, { ok: true });
    },
  },

  {
    method: "POST",
    path: "/git/stash",
    async handler({ deps, json, readBody }) {
      const body = await readBody();
      const ctx = await resolveGit(deps, body.cwd, json);
      if (!ctx) return;
      const files = parseFiles(body, json);
      if (!files) return;
      await ctx.git.stash(ctx.cwd, files);
      json(200, { ok: true });
    },
  },

  {
    method: "POST",
    path: "/git/commit",
    async handler({ deps, json, readBody }) {
      const body = await readBody();
      const ctx = await resolveGit(deps, body.cwd, json);
      if (!ctx) return;
      const message = body.message;
      if (typeof message !== "string" || !message) {
        json(400, { error: "Missing 'message' string in request body" });
        return;
      }
      const flags = body.flags;
      if (
        flags !== undefined &&
        (!Array.isArray(flags) || !flags.every((f) => typeof f === "string"))
      ) {
        json(400, { error: "'flags' must be an array of strings" });
        return;
      }
      await ctx.git.commit(ctx.cwd, message, (flags as string[]) ?? []);
      json(200, { ok: true });
    },
  },

  {
    // Blocks the request for the duration of the push — acceptable for a CLI,
    // guarded by a 5-minute timer that cancels the stream and responds 504
    // rather than hanging the connection forever.
    method: "POST",
    path: "/git/push",
    async handler({ deps, json, readBody }) {
      const body = await readBody();
      const ctx = await resolveGit(deps, body.cwd, json);
      if (!ctx) return;

      const remote = typeof body.remote === "string" ? body.remote : undefined;
      const branch = typeof body.branch === "string" ? body.branch : undefined;
      const setUpstream =
        typeof body.setUpstream === "boolean" ? body.setUpstream : undefined;

      const lines: string[] = [];
      let responded = false;
      // A plain `let` reassigned once flags `prefer-const` even though the
      // assignment has to happen after `pushStream` returns the `cancel` the
      // timeout needs — a boxed field sidesteps that without weakening the
      // timing: `onDone` firing synchronously (as a stub can in tests) sees
      // `current` still `null` and simply skips the clear, and the box is
      // cleared right after in that case instead.
      const timerBox: { current: ReturnType<typeof setTimeout> | null } = {
        current: null,
      };

      const { cancel } = ctx.git.pushStream(
        ctx.cwd,
        { remote, branch, setUpstream },
        {
          onLine: (line) => lines.push(line),
          onDone: (result) => {
            if (responded) return;
            responded = true;
            if (timerBox.current) clearTimeout(timerBox.current);
            json(200, {
              exitCode: result.exitCode,
              lines,
              stderr: result.stderr,
            });
          },
        },
      );

      timerBox.current = setTimeout(() => {
        if (responded) return;
        responded = true;
        cancel();
        json(504, { error: "git push timed out after 5 minutes" });
      }, PUSH_TIMEOUT_MS);
      if (responded) clearTimeout(timerBox.current);
    },
  },

  {
    method: "GET",
    path: "/git/staged-files",
    async handler({ deps, url, json }) {
      const ctx = await resolveGit(deps, url.searchParams.get("cwd"), json);
      if (!ctx) return;
      json(200, await ctx.git.getStagedFiles(ctx.cwd));
    },
  },

  {
    method: "GET",
    path: "/git/diff",
    async handler({ deps, url, json }) {
      const ctx = await resolveGit(deps, url.searchParams.get("cwd"), json);
      if (!ctx) return;
      const scope = url.searchParams.get("scope") ?? "local";
      if (scope !== "local" && scope !== "full") {
        json(400, { error: "Query param 'scope' must be 'local' or 'full'" });
        return;
      }
      const diff =
        scope === "local"
          ? await ctx.git.getLocalDiff(ctx.cwd)
          : await ctx.git.getFullDiff(ctx.cwd, ctx.project.defaultBranch);
      json(200, diff);
    },
  },
];
