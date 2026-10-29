/**
 * `/automations`: list, show, create, update, delete and run this server's
 * automations, and read a run history. What `list-automations`,
 * `create-automation` and the rest of the `manor` CLI call
 * (`../mcp/tools-automations.ts`).
 *
 * Every server keeps its own automations. A request may name the host it is
 * for — `?hostId=` on a read, `hostId` in a write's body; a create may name
 * a project instead, and goes to that project's host. One for an adopted
 * host goes to its server whole and runs through this same route there
 * (`./host-forward.ts`), which is how the desktop's CLI reaches a remote
 * box's automations. On a host server, the CLI relay refuses every request
 * until the host is adopted (`../host-server/cli-relay.ts`).
 *
 * Electron-free: the host server bundles it.
 */

import { LOCAL_HOST_ID } from "../../src/lib/workspace-key";
import {
  AutomationRequestError,
  automationDetail,
  createAutomation,
  listAutomationViews,
  removeAutomation,
  requireAutomation,
  runAutomationNow,
  runView,
  updateAutomation,
} from "../automations/operations";
import { forwardToHost, onAdoptedHost } from "./host-forward";
import type { RouteContext, ServerRoute, ServerRouteDeps } from "./types";

type Ctx = RouteContext<ServerRouteDeps>;

/** The request's answer, or the refusal it threw, as JSON. */
async function answer(ctx: Ctx, work: () => unknown): Promise<void> {
  try {
    ctx.json(200, await work());
  } catch (err) {
    if (!(err instanceof AutomationRequestError)) throw err;
    ctx.json(err.status, { error: err.message });
  }
}

/**
 * A request for `hostId`'s automations: answered here when that is this
 * server, sent whole to an adopted host's server, refused otherwise. True
 * when it was answered (or refused) without running the route here.
 */
async function elsewhere(ctx: Ctx, hostId: unknown, body: Record<string, unknown>): Promise<boolean> {
  if (hostId === undefined || hostId === null || hostId === "" || hostId === LOCAL_HOST_ID) {
    return false;
  }
  if (typeof hostId !== "string") {
    ctx.json(400, { error: "'hostId' must be a string" });
    return true;
  }
  if (onAdoptedHost(ctx.deps, hostId)) {
    const { hostId: _hostId, ...rest } = body;
    const search = new URLSearchParams(ctx.url.search);
    search.delete("hostId");
    const query = search.toString();
    await forwardToHost(
      ctx.deps,
      ctx.json,
      hostId,
      ctx.method,
      ctx.url.pathname + (query ? `?${query}` : ""),
      rest,
    );
    return true;
  }
  const label = ctx.deps.projectManager.hostLabel(hostId);
  ctx.json(400, { error: `${label} has no Manor host server yet, so it can't run automations` });
  return true;
}

/** A read: the host is `?hostId=`. */
function read(handler: (ctx: Ctx) => unknown): ServerRoute["handler"] {
  return async (ctx) => {
    if (await elsewhere(ctx, ctx.url.searchParams.get("hostId"), {})) return;
    await answer(ctx, () => handler(ctx));
  };
}

/** A write: the host is the body's `hostId`. */
function write(
  handler: (ctx: Ctx, body: Record<string, unknown>) => unknown,
): ServerRoute["handler"] {
  return async (ctx) => {
    const body = await ctx.readBody();
    if (await elsewhere(ctx, body.hostId, body)) return;
    const { hostId: _hostId, ...rest } = body;
    await answer(ctx, () => handler(ctx, rest));
  };
}

export const automationRoutes: ServerRoute[] = [
  {
    method: "GET",
    path: "/automations",
    handler: read(({ deps }) => listAutomationViews(deps)),
  },

  {
    // The host is the body's `hostId`, else the project's.
    method: "POST",
    path: "/automations",
    async handler(ctx) {
      const body = await ctx.readBody();
      let hostId = body.hostId;
      if (hostId === undefined && typeof body.projectId === "string") {
        const projects = await ctx.deps.projectManager.getProjects();
        hostId = projects.find((p) => p.id === body.projectId)?.hostId;
      }
      if (await elsewhere(ctx, hostId, body)) return;
      const { hostId: _hostId, ...input } = body;
      await answer(ctx, () => createAutomation(ctx.deps, input));
    },
  },

  {
    method: "GET",
    path: "/automations/:automationId",
    handler: read(({ deps, params }) => automationDetail(deps, requireAutomation(deps, params.automationId))),
  },

  {
    method: "POST",
    path: "/automations/:automationId/update",
    handler: write(({ deps, params }, patch) => updateAutomation(deps, params.automationId, patch)),
  },

  {
    method: "DELETE",
    path: "/automations/:automationId",
    handler: write(({ deps, params }) => {
      removeAutomation(deps, params.automationId);
      return { ok: true };
    }),
  },

  {
    // Fires now, enabled or not; answers the run once it has started (or
    // failed to).
    method: "POST",
    path: "/automations/:automationId/run",
    handler: write(({ deps, params }) => runAutomationNow(deps, params.automationId)),
  },

  {
    method: "GET",
    path: "/automations/:automationId/runs",
    handler: read(({ deps, params }) => {
      const automation = requireAutomation(deps, params.automationId);
      return deps.automations.store.runs(automation.id).map((run) => runView(deps, run));
    }),
  },
];
