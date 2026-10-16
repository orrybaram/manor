/**
 * Each bundled template's checks (ADR-234 D6, D8): what `hosts.checkTemplate`
 * answers — the readiness checklist and the options of the template's
 * `choice` fields — probed in main with short-timeout commands.
 */

import type { TemplateCheckResult } from "../types";
import { check as checkDocker } from "./docker";
import { check as checkKubernetes } from "./kubernetes";
import { defaultCheckDeps, type CheckDeps } from "./deps";

export type { CheckDeps } from "./deps";

type TemplateChecker = (
  values: Record<string, string>,
  deps: CheckDeps,
) => Promise<TemplateCheckResult>;

/** By template id. A template without checks answers none. */
const CHECKERS = new Map<string, TemplateChecker>([
  ["docker", checkDocker],
  ["kubernetes", checkKubernetes],
]);

export async function runTemplateChecks(
  templateId: string,
  values: Record<string, string>,
  deps: CheckDeps = defaultCheckDeps,
): Promise<TemplateCheckResult> {
  const checker = CHECKERS.get(templateId);
  return checker ? checker(values, deps) : { checks: [], choices: {} };
}
