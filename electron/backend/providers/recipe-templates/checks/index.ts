/**
 * Each bundled template's checks (ADR-234 D6, D8): what `hosts.checkTemplate`
 * answers — the readiness checklist and the options of the template's
 * `choice` fields — probed in main with short-timeout commands; and their
 * `run` fixes (`hosts.runTemplateFix`).
 */

import type { TemplateCheckResult } from "../types";
import { check as checkDocker, runFix as runDockerFix } from "./docker";
import { check as checkKubernetes } from "./kubernetes";
import { defaultCheckDeps, type CheckDeps } from "./deps";

export { defaultCheckDeps, type CheckDeps } from "./deps";
export { stopTemplateJobs } from "./jobs";

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

type TemplateFixer = (fixId: string, values: Record<string, string>, deps: CheckDeps) => Promise<void>;

/** By template id. A template with no `run` fixes has none to run. */
const FIXERS = new Map<string, TemplateFixer>([["docker", runDockerFix]]);

/** Carry out template `templateId`'s `run` fix `fixId`; an unknown one is an error. */
export async function runTemplateFixById(
  templateId: string,
  fixId: string,
  values: Record<string, string>,
  deps: CheckDeps = defaultCheckDeps,
): Promise<void> {
  const fixer = FIXERS.get(templateId);
  if (!fixer) throw new Error(`Unknown fix: ${JSON.stringify(fixId)}`);
  await fixer(fixId, values, deps);
}
