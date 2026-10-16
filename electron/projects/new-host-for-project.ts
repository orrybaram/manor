/**
 * "In a new pod" (ADR-235 D3): make a host for one project from a host
 * profile, bring it up, and clone the project onto it — the one operation
 * behind `projects.openInNewHost`.
 *
 * In order: pick a free name from the repo's (`podNameFor`), write a recipe
 * from the profile's template and answers, add the host (`addRecipeHost`,
 * also `hosts.addRecipeHost`'s), wait for it to come up and for its server
 * to adopt it (ADR-227), so the clone is made on the host's server; then
 * clone the repo there — or, from Set up on, copy the source project there,
 * joining its group (ADR-214) — and mark the host as the project's (D5).
 *
 * A failure keeps the host, and says at which stage it failed: the recipe's
 * output is what the user needs to fix it, and nothing is destroyed without
 * asking. `retryFrom` resumes on that host.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import {
  createRecipeFromTemplate,
  RECIPE_TEMPLATES,
} from "../backend/providers/recipe-templates";
import type {
  RecipeTemplate,
  TemplateContext,
} from "../backend/providers/recipe-templates/types";
import { assertRecipeId, readRecipe, recipeDir, writeRecipe } from "../backend/providers/recipes";
import type { BackendRegistry } from "../backend/registry";
import type { HostAdoption } from "../backend/host-adoption";
import { hostRecipesDir } from "../paths";
import { toDirSlug } from "../branch-name";
import type { ProjectManager } from "./project-manager";
import type { ProjectInfo, TransferResult } from "./types";

// ── Adding a recipe host ──

export interface AddRecipeHostDeps {
  projectManager: Pick<
    ProjectManager,
    "getHosts" | "saveHost" | "setHostSupervised" | "setHostProfileId"
  >;
  backendRegistry: Pick<BackendRegistry, "register" | "ensureConnected">;
}

export interface AddRecipeHostOptions {
  /** The host profile the host is made from (ADR-235 D1). */
  profileId?: string;
  /** What the host is called: written as the recipe's `name`. */
  displayName?: string;
  /** Defaults to `hostRecipesDir()`. For tests. */
  recipesDir?: string;
}

/**
 * Register a host Manor starts from recipe `recipeId` (ADR-229 D2) and
 * start connecting it: the connect runs the recipe's `up`, its stderr lines
 * showing as the host's progress. The recipe must be valid, and a recipe
 * already used by another host is refused, since a recipe's state belongs
 * to one host. `hosts.addRecipeHost`, and `openInNewHost`'s third step.
 */
export function addRecipeHost(
  deps: AddRecipeHostDeps,
  recipeId: string,
  opts: AddRecipeHostOptions = {},
): { hostId: string; spec: { kind: "recipe"; recipeId: string } } {
  assertRecipeId(recipeId);
  const baseDir = opts.recipesDir ?? hostRecipesDir();
  const recipe = readRecipe(recipeId, baseDir);
  const taken = deps.projectManager
    .getHosts()
    .find(({ spec }) => spec.kind === "recipe" && spec.recipeId === recipeId);
  if (taken) {
    throw new Error(`The recipe "${recipe.name}" already starts a host.`);
  }
  const displayName = opts.displayName?.trim();
  if (displayName && displayName !== recipe.name) {
    writeRecipe({ ...recipe, name: displayName }, baseDir);
  }
  const hostId = crypto.randomUUID();
  const spec = { kind: "recipe" as const, recipeId };
  deps.projectManager.saveHost(hostId, spec);
  // A box Manor starts is Manor's to keep running (ADR-229 D4).
  deps.projectManager.setHostSupervised(hostId, true);
  if (opts.profileId !== undefined) deps.projectManager.setHostProfileId(hostId, opts.profileId);
  deps.backendRegistry.register(hostId, spec);
  // A connect somebody means: it runs `up` even for a box asleep.
  deps.backendRegistry.ensureConnected(hostId).catch(() => {
    // Reported through the host's status.
  });
  return { hostId, spec };
}

// ── The name ──

/** A recipe id's longest (`recipes.ts`'s `RECIPE_ID`). */
const MAX_RECIPE_ID = 64;
/** `NAME_PATTERN`'s longest: a DNS label as the templates take one. */
const MAX_NAME = 40;

/**
 * The repo's name in `repoUrl`: its last path segment, without `.git`.
 * `https://github.com/org/app.git`, `git@github.com:org/app` → `app`.
 */
export function repoNameOf(repoUrl: string): string {
  const trimmed = repoUrl.trim().replace(/[/\\]+$/, "");
  const last = trimmed.split(/[/\\:]/).pop() ?? "";
  return last.replace(/\.git$/i, "") || "project";
}

/**
 * A host name for `repoName` that the templates take (`NAME_PATTERN`):
 * lowercase `[a-z0-9-]`, starting with a letter, at most `maxLength`
 * characters, not ending in `-`. One `isTaken` says is used gets `-2`,
 * `-3`, and so on, cut to fit too.
 */
export function podNameFor(
  repoName: string,
  opts: { maxLength: number; isTaken: (name: string) => boolean },
): string {
  const maxLength = Math.max(1, Math.min(MAX_NAME, opts.maxLength));
  let base = toDirSlug(repoName).replace(/[^a-z0-9-]/g, "");
  if (base === "") base = "project";
  if (!/^[a-z]/.test(base)) base = `p-${base}`;
  const fit = (stem: string, suffix: string): string => {
    const cut = stem.slice(0, Math.max(1, maxLength - suffix.length)).replace(/-+$/, "");
    return `${cut || "p"}${suffix}`;
  };
  for (let n = 1; n < 10_000; n++) {
    const name = fit(base, n === 1 ? "" : `-${n}`);
    if (!opts.isTaken(name)) return name;
  }
  throw new Error(`No free host name for "${repoName}".`);
}

/**
 * The longest name `template` takes with `values` so that its recipe id —
 * `kubernetes-<namespace>-<name>`, `docker-<name>` — fits in 64.
 */
function nameLimit(
  template: RecipeTemplate,
  values: Record<string, string>,
  ctx: TemplateContext,
): number {
  const probe = template.recipe({ ...values, name: "x" }, ctx).id;
  const overhead = probe.endsWith("x") ? probe.length - 1 : 0;
  return Math.min(MAX_NAME, MAX_RECIPE_ID - overhead);
}

// ── openInNewHost ──

export interface OpenInNewHostInput {
  profileId: string;
  repoUrl: string;
  /** Set up on (ADR-235 D4): copy this project onto the new host, joining its group. */
  sourceProjectId?: string;
  /** Resume on `hostId`, made by an earlier call, at the stage that failed. */
  retryFrom?: { hostId: string; stage: "up" | "clone" };
}

export type OpenInNewHostResult =
  | { ok: true; project: ProjectInfo; hostId: string }
  | {
      ok: false;
      stage: "up" | "clone";
      hostId?: string;
      error: string;
      /**
       * Set up on could not plan the copy (ADR-213): what to ask, for the
       * existing fallback dialog, which calls `projects.transfer` itself.
       */
      needsInput?: Extract<TransferResult, { ok: false }>["needsInput"];
    };

export interface NewHostDeps {
  projectManager: AddRecipeHostDeps["projectManager"] &
    Pick<
      ProjectManager,
      | "getHostProfile"
      | "assertKnownHost"
      | "cloneProject"
      | "transferProject"
      | "setHostForProject"
    >;
  backendRegistry: AddRecipeHostDeps["backendRegistry"] &
    Pick<BackendRegistry, "version" | "recordChanged">;
  /** The desktop's half of adoption; absent on a server with no remote hosts. */
  hostAdoption?: Pick<HostAdoption, "whenAdopted">;
  /** Defaults to `hostRecipesDir()`. For tests. */
  recipesDir?: string;
  templates?: readonly RecipeTemplate[];
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function openInNewHost(
  deps: NewHostDeps,
  input: OpenInNewHostInput,
): Promise<OpenInNewHostResult> {
  const { projectManager, backendRegistry } = deps;
  const recipesDir = deps.recipesDir ?? hostRecipesDir();
  const repoName = repoNameOf(input.repoUrl);

  let hostId: string;
  if (input.retryFrom) {
    hostId = input.retryFrom.hostId;
    projectManager.assertKnownHost(hostId);
  } else {
    const profile = projectManager.getHostProfile(input.profileId);
    if (!profile) throw new Error(`Unknown host profile "${input.profileId}".`);
    const templates = deps.templates ?? RECIPE_TEMPLATES;
    const template = templates.find((t) => t.id === profile.templateId);
    if (!template) throw new Error(`Unknown template: ${JSON.stringify(profile.templateId)}`);
    const ctx: TemplateContext = { appVersion: backendRegistry.version };
    try {
      // 1. Name: free as a recipe dir and among the hosts' recipes.
      const usedRecipes = new Set(
        projectManager
          .getHosts()
          .flatMap(({ spec }) => (spec.kind === "recipe" ? [spec.recipeId] : [])),
      );
      const name = podNameFor(repoName, {
        maxLength: nameLimit(template, profile.values, ctx),
        isTaken: (candidate) => {
          const id = template.recipe({ ...profile.values, name: candidate }, ctx).id;
          return usedRecipes.has(id) || fs.existsSync(recipeDir(id, recipesDir));
        },
      });
      // 2. Recipe, with the profile's idle stop.
      const recipeId = createRecipeFromTemplate(
        template.id,
        { ...profile.values, name },
        ctx,
        recipesDir,
      );
      if (profile.idleStopMinutes !== undefined) {
        const recipe = readRecipe(recipeId, recipesDir);
        writeRecipe({ ...recipe, idleStopMinutes: profile.idleStopMinutes }, recipesDir);
      }
      // 3. Host.
      hostId = addRecipeHost(deps, recipeId, {
        profileId: profile.id,
        displayName: repoName,
        recipesDir,
      }).hostId;
    } catch (err) {
      return { ok: false, stage: "up", error: messageOf(err) };
    }
  }

  // 4. Up, and adopted: the clone then goes to the host's server. Run on
  // a retry from `clone` too: both are idempotent, and the clone needs them.
  try {
    await backendRegistry.ensureConnected(hostId);
    await deps.hostAdoption?.whenAdopted(hostId);
  } catch (err) {
    return { ok: false, stage: "up", hostId, error: messageOf(err) };
  }

  // 5. Clone, or Set up on's copy.
  let project: ProjectInfo;
  try {
    if (input.sourceProjectId === undefined) {
      project = await projectManager.cloneProject({
        hostId,
        repoUrl: input.repoUrl,
        targetDir: `~/code/${toDirSlug(repoName) || "project"}`,
        name: repoName,
      });
    } else {
      const result = await projectManager.transferProject(input.sourceProjectId, hostId, "copy");
      if (!result.ok) {
        return {
          ok: false,
          stage: "clone",
          hostId,
          error: "Manor needs to know where to set the project up.",
          needsInput: result.needsInput,
        };
      }
      project = result.project;
    }
  } catch (err) {
    return { ok: false, stage: "clone", hostId, error: messageOf(err) };
  }

  // 6. Mark.
  projectManager.setHostForProject(hostId, project.id);
  backendRegistry.recordChanged(hostId);
  return { ok: true, project, hostId };
}
