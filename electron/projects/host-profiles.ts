/**
 * Host profiles in `projects.json` (ADR-235 D1): a recipe template plus the
 * answers every host made from it shares. Modelled on `host-records.ts`.
 *
 * A profile never holds the template's `perHost` answers (the host's name),
 * which `openInNewHost` picks per project, and never a secret.
 */

import crypto from "node:crypto";
import { RECIPE_TEMPLATES } from "../backend/providers/recipe-templates";
import type {
  RecipeTemplate,
  TemplateContext,
} from "../backend/providers/recipe-templates/types";
import type { StateStore } from "./state-store";
import type { HostProfile } from "./types";

/** The idle stops a profile may pick (ADR-235 D2): minutes. */
export const IDLE_STOP_CHOICES: readonly number[] = [30, 60, 120];

/** A new profile's idle stop when none is given (ADR-235 Q6). */
export const DEFAULT_IDLE_STOP_MINUTES = 60;

/**
 * What the editor saves. Without `id`, a new profile. `idleStopMinutes`:
 * a number sets it, `null` turns it off, and leaving it out keeps what the
 * profile had — the default of 60 for a new one.
 */
export interface HostProfileInput {
  id?: string;
  name: string;
  templateId: string;
  values: Record<string, string>;
  idleStopMinutes?: number | null;
}

export class HostProfiles {
  constructor(
    private readonly store: StateStore,
    private readonly templates: readonly RecipeTemplate[] = RECIPE_TEMPLATES,
  ) {}

  /** Every profile, in the order they were made. */
  list(): HostProfile[] {
    return Object.values(this.store.state.hostProfiles ?? {}).map(copy);
  }

  get(profileId: string): HostProfile | undefined {
    const profile = this.store.state.hostProfiles?.[profileId];
    return profile ? copy(profile) : undefined;
  }

  /**
   * Make or update a profile, and answer it as saved. Throws, writing
   * nothing, when the template is unknown, an answer is for a `perHost` or
   * unknown field, the idle stop is not one of `IDLE_STOP_CHOICES`, or the
   * template refuses the answers. Editing one changes no existing host.
   */
  save(input: HostProfileInput, ctx: TemplateContext): HostProfile {
    const name = input.name.trim();
    if (name === "") throw new Error("A profile name is required.");
    const template = this.templates.find((t) => t.id === input.templateId);
    if (!template) throw new Error(`Unknown template: ${JSON.stringify(input.templateId)}`);

    const fieldKeys = new Set(template.fields.map((f) => f.key));
    for (const key of Object.keys(input.values)) {
      if (template.perHost.includes(key)) {
        throw new Error(`A profile can't store "${key}": it differs for each host.`);
      }
      if (!fieldKeys.has(key)) {
        throw new Error(`The ${template.name} template has no field "${key}".`);
      }
    }
    // The template checks every answer when it makes a recipe; a stand-in
    // for the per-host ones lets it check the rest now.
    const probe: Record<string, string> = { ...input.values };
    for (const key of template.perHost) probe[key] = "probe";
    template.recipe(probe, ctx);

    const existing = input.id !== undefined ? this.store.state.hostProfiles?.[input.id] : undefined;
    if (input.id !== undefined && !existing) {
      throw new Error(`Unknown host profile "${input.id}".`);
    }
    const idleStopMinutes =
      input.idleStopMinutes === undefined
        ? existing
          ? existing.idleStopMinutes
          : DEFAULT_IDLE_STOP_MINUTES
        : (input.idleStopMinutes ?? undefined);
    if (idleStopMinutes !== undefined && !IDLE_STOP_CHOICES.includes(idleStopMinutes)) {
      throw new Error(
        `"Stop when idle" must be off or one of ${IDLE_STOP_CHOICES.join(", ")} minutes.`,
      );
    }

    const profile: HostProfile = {
      id: existing?.id ?? newProfileId(),
      name,
      templateId: template.id,
      values: { ...input.values },
      ...(idleStopMinutes !== undefined ? { idleStopMinutes } : {}),
      ...(existing?.signIn ? { signIn: existing.signIn } : {}),
    };
    const state = this.store.state;
    if (!state.hostProfiles) state.hostProfiles = {};
    state.hostProfiles[profile.id] = profile;
    this.store.save();
    return copy(profile);
  }

  /**
   * Forget `profileId`. Its hosts stay, as ordinary hosts: their
   * `profileId` is cleared in the same write (ADR-235 D1).
   */
  remove(profileId: string): void {
    const state = this.store.state;
    if (!state.hostProfiles?.[profileId]) return;
    delete state.hostProfiles[profileId];
    if (Object.keys(state.hostProfiles).length === 0) delete state.hostProfiles;
    for (const host of Object.values(state.hosts ?? {})) {
      if (host.profileId === profileId) delete host.profileId;
    }
    this.store.save();
  }
}

function newProfileId(): string {
  return `hp-${crypto.randomBytes(6).toString("hex")}`;
}

function copy(profile: HostProfile): HostProfile {
  return {
    ...profile,
    values: { ...profile.values },
    ...(profile.signIn
      ? {
          signIn: {
            ...(profile.signIn.github ? { github: { ...profile.signIn.github } } : {}),
            ...(profile.signIn.claude ? { claude: { ...profile.signIn.claude } } : {}),
          },
        }
      : {}),
  };
}
