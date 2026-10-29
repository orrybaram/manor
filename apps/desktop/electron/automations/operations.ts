import type { SharedDeps } from "../ipc/types";
import { LOCAL_HOST_ID } from "../../src/lib/workspace-key";
import type { Automation, AutomationInput, AutomationRun } from "../../src/lib/automations";
import {
  AUTOMATION_NEXT_RUNS,
  type AutomationDetail,
  type AutomationRunView,
  type AutomationView,
} from "../../src/lib/automation-views";
import { nextRuns } from "./cron";
import { runAgent } from "./run-agent";

/**
 * What every surface does with this server's automations — the HTTP routes
 * (`../routes/automations.ts`), the bridge's `automations.*`
 * (`../bridge/handlers/automations.ts`) and through the routes the MCP
 * tools and the `manor` CLI — written once: the views they answer with, and
 * the writes, each checked the same way.
 *
 * Everything here is about this server's own store. Which server a request
 * is for (an adopted host's, say) is decided before it gets here.
 */

export type AutomationDeps = Pick<
  SharedDeps,
  "automations" | "agentManager" | "agentStatus" | "projectManager"
>;

/** A request this server refuses, with the HTTP status a route answers. */
export class AutomationRequestError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404,
  ) {
    super(message);
    this.name = "AutomationRequestError";
  }
}

/** A run with its Agent status now. Only a started run has an Agent of its own. */
export function runView(deps: AutomationDeps, run: AutomationRun): AutomationRunView {
  if (run.outcome !== "started") return { ...run, status: null };
  const { agent, status } = runAgent(deps, run);
  return { ...run, status, ...(agent ? { agentId: agent.id } : {}) };
}

export function automationView(
  deps: AutomationDeps,
  automation: Automation,
  now: number = Date.now(),
): AutomationView {
  const [newest] = deps.automations.store.runs(automation.id);
  return {
    ...automation,
    hostId: LOCAL_HOST_ID,
    nextRuns: nextRuns(automation.schedule, now, AUTOMATION_NEXT_RUNS).map((d) => d.toISOString()),
    lastRun: newest ? runView(deps, newest) : null,
  };
}

export function automationDetail(deps: AutomationDeps, automation: Automation): AutomationDetail {
  return {
    ...automationView(deps, automation),
    runs: deps.automations.store.runs(automation.id).map((run) => runView(deps, run)),
  };
}

export function listAutomationViews(deps: AutomationDeps): AutomationView[] {
  const now = Date.now();
  return deps.automations.store.list().map((a) => automationView(deps, a, now));
}

/** The automation, or a 404. */
export function requireAutomation(deps: AutomationDeps, id: unknown): Automation {
  const automation = typeof id === "string" ? deps.automations.store.get(id) : null;
  if (!automation) throw new AutomationRequestError(`Automation not found: ${String(id)}`, 404);
  return automation;
}

/**
 * A project this server can fire for: one on its own host. The desktop
 * lists a remote host's projects too, but its local server never fires
 * them (`./fire-run.ts`), and a host with no Manor host server has nowhere
 * else to run one.
 */
async function assertProjectHere(deps: AutomationDeps, projectId: unknown): Promise<void> {
  // A missing or malformed id is the validation's to word.
  if (typeof projectId !== "string" || projectId === "") return;
  const project = (await deps.projectManager.getProjects()).find((p) => p.id === projectId);
  if (!project) throw new AutomationRequestError(`Project not found: ${projectId}`, 400);
  if (project.hostId !== LOCAL_HOST_ID) {
    const label = deps.projectManager.hostLabel(project.hostId);
    throw new AutomationRequestError(
      `${label} has no Manor host server yet, so it can't run automations`,
      400,
    );
  }
}

/** The store's validation throw, as a 400. */
function validated<T>(write: () => T): T {
  try {
    return write();
  } catch (err) {
    throw new AutomationRequestError(err instanceof Error ? err.message : String(err), 400);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AutomationRequestError("Expected an object", 400);
  }
  return value as Record<string, unknown>;
}

/** Throws `AutomationRequestError` for input the store refuses or a project not here. */
export async function createAutomation(deps: AutomationDeps, input: unknown): Promise<AutomationView> {
  const body = asRecord(input);
  await assertProjectHere(deps, body.projectId);
  const created = validated(() =>
    deps.automations.store.create(body as unknown as AutomationInput, Date.now()),
  );
  return automationView(deps, created);
}

/**
 * Only the fields `patch` names change. A schedule patch may name only its
 * cron or its timezone; the other is kept.
 */
export async function updateAutomation(
  deps: AutomationDeps,
  id: unknown,
  patch: unknown,
): Promise<AutomationView> {
  const current = requireAutomation(deps, id);
  const body = asRecord(patch);
  if ("projectId" in body) await assertProjectHere(deps, body.projectId);
  const next: Partial<AutomationInput> = { ...(body as Partial<AutomationInput>) };
  if (body.schedule !== undefined) {
    next.schedule = { ...current.schedule, ...asRecord(body.schedule) };
  }
  const updated = validated(() => deps.automations.store.update(current.id, next, Date.now()));
  if (!updated) throw new AutomationRequestError(`Automation not found: ${current.id}`, 404);
  return automationView(deps, updated);
}

export function removeAutomation(deps: AutomationDeps, id: unknown): void {
  const automation = requireAutomation(deps, id);
  deps.automations.store.remove(automation.id);
}

/** Fires it now, enabled or not; the run as recorded. */
export async function runAutomationNow(deps: AutomationDeps, id: unknown): Promise<AutomationRunView> {
  const automation = requireAutomation(deps, id);
  return runView(deps, await deps.automations.scheduler.runNow(automation.id));
}
