/**
 * Host profiles (ADR-235 D1): a recipe template plus saved answers, from
 * which a new host is made per project. Listing, saving and removing them,
 * and their sign-in Secret (D9).
 *
 * All `localOnly` and answered by home: a profile is what this desktop will
 * run recipes from, on its own machine, with its own `docker` / `kubectl`
 * config — the desktop user's call alone, like `hosts.createRecipe`. Thin:
 * validation of the answers lives in `projects/host-profiles.ts`.
 */

import { assertNumber, assertString } from "../../ipc-validate";
import type { HostProfileInput, SignInKind } from "../../projects/host-profiles";
import { readRecipe } from "../../backend/providers/recipes";
import {
  defaultSignInDeps,
  profileKubeTarget,
  removeSignIn,
  restartPods,
  writeSignIn,
  type ProfileHost,
  type SignInDeps,
  type SignInInput,
} from "../../backend/providers/recipe-templates/signin";
import type { HostProfile } from "../../projects/types";
import type { ServerDeps } from "../../ipc/types";
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
  return ctx.deps.projectManager.saveHostProfile(
    {
      ...(input.id !== undefined ? { id: input.id } : {}),
      name: input.name,
      templateId: input.templateId,
      values: input.values,
      ...(input.idleStopMinutes !== undefined ? { idleStopMinutes: input.idleStopMinutes } : {}),
    },
    { appVersion: ctx.deps.backendRegistry.version },
  );
}

/** Forget a profile. Its hosts stay, and lose their `profileId`. */
export function hostProfilesRemove(ctx: HandlerCtx<ServerDeps>, profileId: string): void {
  assertString(profileId, "hostProfiles:remove.profileId");
  ctx.deps.projectManager.removeHostProfile(profileId);
}

/**
 * "Sign new pods in for me" (ADR-235 D9): put the GitHub and/or Claude
 * token into the profile's `manor-signin` Secret, then record when and how
 * on the profile. Kubernetes profiles only. The token goes to kubectl on
 * stdin and is kept nowhere on this computer.
 */
export async function hostProfilesSetSignIn(
  ctx: HandlerCtx<ServerDeps>,
  profileId: string,
  input: SignInInput,
): Promise<HostProfile> {
  assertString(profileId, "hostProfiles:setSignIn.profileId");
  const clean = assertSignInInput(input);
  const profile = knownProfile(ctx, profileId);
  const meta = await writeSignIn(profile, clean, signInDeps);
  let saved = profile;
  for (const which of SIGN_IN_KINDS) {
    const m = meta[which];
    if (m) saved = ctx.deps.projectManager.setHostProfileSignIn(profileId, which, m);
  }
  return saved;
}

/** Take one token out of the profile's Secret, and forget that it was set. */
export async function hostProfilesRemoveSignIn(
  ctx: HandlerCtx<ServerDeps>,
  profileId: string,
  which: SignInKind,
): Promise<HostProfile> {
  assertString(profileId, "hostProfiles:removeSignIn.profileId");
  if (!SIGN_IN_KINDS.includes(which)) {
    throw new Error('hostProfiles:removeSignIn.which must be "github" or "claude"');
  }
  const profile = knownProfile(ctx, profileId);
  await removeSignIn(profile, which, signInDeps);
  return ctx.deps.projectManager.setHostProfileSignIn(profileId, which, null);
}

/**
 * Delete the pod of each running host of the profile, so it restarts with
 * the Secret as it is now. Answers the ids of the hosts restarted.
 */
export async function hostProfilesRestartPods(
  ctx: HandlerCtx<ServerDeps>,
  profileId: string,
): Promise<{ restarted: string[] }> {
  assertString(profileId, "hostProfiles:restartPods.profileId");
  profileKubeTarget(knownProfile(ctx, profileId));
  const pm = ctx.deps.projectManager;
  const hosts: ProfileHost[] = [];
  for (const { hostId, spec } of pm.getHosts()) {
    if (spec.kind !== "recipe" || pm.hostProfileId(hostId) !== profileId) continue;
    try {
      hosts.push({ hostId, recipe: readRecipe(spec.recipeId) });
    } catch {
      // Its recipe is gone or broken: nothing to restart from.
    }
  }
  return { restarted: await restartPods(hosts, signInDeps) };
}

const SIGN_IN_KINDS: readonly SignInKind[] = ["github", "claude"];

/** What sign-in runs kubectl and gh with. */
const signInDeps: SignInDeps = defaultSignInDeps;

function knownProfile(ctx: HandlerCtx<ServerDeps>, profileId: string): HostProfile {
  const profile = ctx.deps.projectManager.getHostProfile(profileId);
  if (!profile) throw new Error(`Unknown host profile "${profileId}".`);
  return profile;
}

/**
 * The wire shape of `SignInInput`, rebuilt from only the fields it allows.
 * Errors name the field, never its value.
 */
function assertSignInInput(input: unknown): SignInInput {
  const what = "hostProfiles:setSignIn.input";
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`${what} must be an object`);
  }
  const { github, claude } = input as { github?: unknown; claude?: unknown };
  const out: SignInInput = {};
  if (github !== undefined) {
    const g = github as { source?: unknown; token?: unknown } | null;
    if (typeof g !== "object" || g === null) throw new Error(`${what}.github must be an object`);
    if (g.source === "gh") out.github = { source: "gh" };
    else if (g.source === "pasted") {
      if (typeof g.token !== "string") throw new Error(`${what}.github.token must be a string`);
      out.github = { source: "pasted", token: g.token };
    } else throw new Error(`${what}.github.source must be "gh" or "pasted"`);
  }
  if (claude !== undefined) {
    const c = claude as { token?: unknown } | null;
    if (typeof c !== "object" || c === null || typeof c.token !== "string") {
      throw new Error(`${what}.claude.token must be a string`);
    }
    out.claude = { token: c.token };
  }
  if (!out.github && !out.claude) throw new Error(`${what} sets no token`);
  return out;
}

export const hostProfiles = {
  list: method(hostProfilesList, { localOnly: true, route: LOCAL_ROUTE }),
  save: method(hostProfilesSave, { localOnly: true, mutating: true, route: LOCAL_ROUTE }),
  remove: method(hostProfilesRemove, { localOnly: true, mutating: true, route: LOCAL_ROUTE }),
  // Not `mutating`: an audit line records arguments, and this one carries a
  // token. Being `localOnly`, no device can call it, so none is ever due.
  setSignIn: method(hostProfilesSetSignIn, { localOnly: true, route: LOCAL_ROUTE }),
  removeSignIn: method(hostProfilesRemoveSignIn, { localOnly: true, mutating: true, route: LOCAL_ROUTE }),
  restartPods: method(hostProfilesRestartPods, { localOnly: true, mutating: true, route: LOCAL_ROUTE }),
};
