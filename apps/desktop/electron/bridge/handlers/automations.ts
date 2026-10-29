import { assertString } from "../../ipc-validate";
import {
  automationDetail,
  automationView,
  createAutomation,
  listAutomationViews,
  removeAutomation,
  requireAutomation,
  runAutomationNow,
  updateAutomation,
  type AutomationDeps,
} from "../../automations/operations";
import type { AutomationInput } from "../../../src/lib/automations";
import type {
  AutomationDetail,
  AutomationRunView,
  AutomationView,
} from "../../../src/lib/automation-views";
import { LOCAL_HOST_ID } from "../../../src/lib/workspace-key";
import { BridgeUnavailableRefusal, UNAVAILABLE_HOST_CODE } from "../types";
import { byHost, method, type HandlerCtx } from "../method";

/**
 * `automations.*`: one host's automations, named by the host id each method
 * takes first (null for the caller's own server). Every server keeps its
 * own and fires them itself, so a call for an adopted remote host is
 * answered by that host's server (`byHost`), which knows itself as `local`.
 * The renderer lists each host it shows with its own call, and hears
 * `automations.onChanged` when any of them changes.
 *
 * A call that lands here for another host is for one with no Manor host
 * server to keep its automations: refused, the way a host away is.
 *
 * The answers are the shared views (`../../automations/operations.ts`): each
 * run with its Agent's status now.
 */

type Ctx = HandlerCtx<AutomationDeps>;

function assertHere(ctx: Ctx, hostId: string | null | undefined): void {
  if (hostId === null || hostId === undefined || hostId === "" || hostId === LOCAL_HOST_ID) return;
  assertString(hostId, "hostId");
  const label = ctx.deps.projectManager.hostLabel(hostId);
  throw new BridgeUnavailableRefusal(
    `${label} has no Manor host server yet, so it can't run automations`,
    UNAVAILABLE_HOST_CODE,
  );
}

export function automationsList(ctx: Ctx, hostId: string | null): AutomationView[] {
  assertHere(ctx, hostId);
  return listAutomationViews(ctx.deps);
}

/** The automation with its runs, newest first; null for an unknown id. */
export function automationsGet(ctx: Ctx, hostId: string | null, id: string): AutomationDetail | null {
  assertHere(ctx, hostId);
  assertString(id, "id");
  const automation = ctx.deps.automations.store.get(id);
  return automation ? automationDetail(ctx.deps, automation) : null;
}

/** Starts paused unless `input.enabled` says otherwise. */
export function automationsCreate(
  ctx: Ctx,
  hostId: string | null,
  input: AutomationInput,
): Promise<AutomationView> {
  assertHere(ctx, hostId);
  return createAutomation(ctx.deps, input);
}

export function automationsUpdate(
  ctx: Ctx,
  hostId: string | null,
  id: string,
  patch: Partial<AutomationInput>,
): Promise<AutomationView> {
  assertHere(ctx, hostId);
  assertString(id, "id");
  return updateAutomation(ctx.deps, id, patch);
}

/**
 * Pause or resume. On a host server this and `runNow` are the writes a
 * paired device may make; making, changing and deleting one are the
 * owner's there (`localOnly` in `../../host-server/handlers.ts`). On the
 * desktop's table none is `localOnly`, as `projects.update` is not, so a
 * device paired with the desktop may make every write.
 */
export async function automationsSetEnabled(
  ctx: Ctx,
  hostId: string | null,
  id: string,
  enabled: boolean,
): Promise<AutomationView> {
  assertHere(ctx, hostId);
  assertString(id, "id");
  if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean");
  const automation = requireAutomation(ctx.deps, id);
  if (automation.enabled === enabled) return automationView(ctx.deps, automation);
  return updateAutomation(ctx.deps, id, { enabled });
}

/** Whether it existed. Its runs go with it; their workspaces stay. */
export function automationsRemove(ctx: Ctx, hostId: string | null, id: string): boolean {
  assertHere(ctx, hostId);
  assertString(id, "id");
  if (!ctx.deps.automations.store.get(id)) return false;
  removeAutomation(ctx.deps, id);
  return true;
}

/** Fires it now, enabled or not: the run as recorded. */
export function automationsRunNow(
  ctx: Ctx,
  hostId: string | null,
  id: string,
): Promise<AutomationRunView> {
  assertHere(ctx, hostId);
  assertString(id, "id");
  return runAutomationNow(ctx.deps, id);
}

export const automations = {
  list: method(automationsList, { route: byHost(0) }),
  get: method(automationsGet, { route: byHost(0) }),
  create: method(automationsCreate, { route: byHost(0), mutating: true }),
  update: method(automationsUpdate, { route: byHost(0), mutating: true }),
  setEnabled: method(automationsSetEnabled, { route: byHost(0), mutating: true }),
  remove: method(automationsRemove, { route: byHost(0), mutating: true }),
  runNow: method(automationsRunNow, { route: byHost(0), mutating: true }),
};
