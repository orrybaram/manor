/**
 * Host profiles (ADR-235 D1): a recipe template plus saved answers, from
 * which a new host is made per project. Listing, saving and removing them.
 *
 * All `localOnly` and answered by home: a profile is what this desktop will
 * run recipes from, on its own machine, with its own `docker` / `kubectl`
 * config — the desktop user's call alone, like `hosts.createRecipe`. Thin:
 * validation of the answers lives in `projects/host-profiles.ts`.
 */

import { assertNumber, assertString } from "../../ipc-validate";
import type { HostProfileInput } from "../../projects/host-profiles";
import type { HostProfile } from "../../projects/types";
import type { ServerDeps } from "../../ipc/types";
import { publishRendererBroadcast } from "../../renderer-broadcast";
import { LOCAL_ROUTE, method, type HandlerCtx } from "../method";
import { assertFormValues } from "./hosts";

export function hostProfilesList(ctx: HandlerCtx<ServerDeps>): HostProfile[] {
  return ctx.deps.projectManager.listHostProfiles();
}

/**
 * Make (no `id`) or update a profile, and answer it as saved. Throws when
 * the template refuses the answers, or an answer is for a per-host field.
 * `idleStopMinutes: null` turns idle stop off; leaving it out keeps the
 * profile's, or 60 for a new one.
 */
export function hostProfilesSave(
  ctx: HandlerCtx<ServerDeps>,
  input: HostProfileInput,
): HostProfile {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("hostProfiles:save.input must be an object");
  }
  if (input.id !== undefined) assertString(input.id, "hostProfiles:save.id");
  assertString(input.name, "hostProfiles:save.name");
  assertString(input.templateId, "hostProfiles:save.templateId");
  assertFormValues(input.values, "hostProfiles:save.values");
  if (input.idleStopMinutes !== undefined && input.idleStopMinutes !== null) {
    assertNumber(input.idleStopMinutes, "hostProfiles:save.idleStopMinutes");
  }
  const saved = ctx.deps.projectManager.saveHostProfile(
    {
      ...(input.id !== undefined ? { id: input.id } : {}),
      name: input.name,
      templateId: input.templateId,
      values: input.values,
      ...(input.idleStopMinutes !== undefined ? { idleStopMinutes: input.idleStopMinutes } : {}),
    },
    { appVersion: ctx.deps.backendRegistry.version },
  );
  publishRendererBroadcast("hostProfiles", "changed");
  return saved;
}

/** Forget a profile. Its hosts stay, and lose their `profileId`. */
export function hostProfilesRemove(ctx: HandlerCtx<ServerDeps>, profileId: string): void {
  assertString(profileId, "hostProfiles:remove.profileId");
  ctx.deps.projectManager.removeHostProfile(profileId);
  publishRendererBroadcast("hostProfiles", "changed");
}

export const hostProfiles = {
  list: method(hostProfilesList, { localOnly: true, route: LOCAL_ROUTE }),
  save: method(hostProfilesSave, { localOnly: true, mutating: true, route: LOCAL_ROUTE }),
  remove: method(hostProfilesRemove, { localOnly: true, mutating: true, route: LOCAL_ROUTE }),
};
