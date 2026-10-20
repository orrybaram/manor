/**
 * The bundled recipe templates. Creating a recipe from one
 * writes its scripts and a `recipe.json` into `~/.manor/host-recipes/<id>/`;
 * after that it is an ordinary recipe, run by `recipe-runner.ts`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { hostRecipesDir } from "../../../paths";
import { parseRecipe, recipeDir, writeRecipe } from "../recipes";
import { dockerTemplate } from "./docker";
import { kubernetesTemplate } from "./kubernetes";
import { defaultCheckDeps, runTemplateChecks, runTemplateFixById, type CheckDeps } from "./checks";
import type { RecipeTemplate, TemplateCheckResult, TemplateContext, TemplateInfo } from "./types";

export type {
  Choice,
  FormField,
  FormFieldType,
  RecipeTemplate,
  TemplateCheck,
  TemplateCheckResult,
  TemplateContext,
  TemplateFile,
  TemplateFix,
  TemplateInfo,
} from "./types";
export { createCustomRecipe } from "./custom";
export { stopTemplateJobs } from "./checks";

export const RECIPE_TEMPLATES: readonly RecipeTemplate[] = [dockerTemplate, kubernetesTemplate];

/** The templates' metadata for the "Start a host" form. */
export function listTemplates(ctx: TemplateContext): TemplateInfo[] {
  return RECIPE_TEMPLATES.map((template) => ({
    id: template.id,
    name: template.name,
    description: template.description,
    fields: template.fields.map(({ default: def, ...field }) => ({
      ...field,
      ...(def !== undefined ? { default: typeof def === "function" ? def(ctx) : def } : {}),
    })),
    perHost: [...template.perHost],
  }));
}

/**
 * Template `templateId`'s checklist and its `choice` fields' options for the
 * form's `values`. `deps` overrides the real probes in
 * part (the app version, tests' fakes). Probes never throw for a missing CLI or a
 * broken config; they list nothing. An unknown template is an error.
 */
export function checkTemplate(
  templateId: string,
  values: Record<string, string>,
  deps?: Partial<CheckDeps>,
): Promise<TemplateCheckResult> {
  if (!RECIPE_TEMPLATES.some((t) => t.id === templateId)) {
    return Promise.reject(new Error(`Unknown template: ${JSON.stringify(templateId)}`));
  }
  return runTemplateChecks(templateId, values, { ...defaultCheckDeps, ...deps });
}

/**
 * Carry out template `templateId`'s `run` fix `fixId` for the form's
 * `values`: open an app, or start a background pull or build
 * that the next `checkTemplate` reports on. Resolves once started.
 */
export function runTemplateFix(
  templateId: string,
  fixId: string,
  values: Record<string, string>,
  deps?: Partial<CheckDeps>,
): Promise<void> {
  if (!RECIPE_TEMPLATES.some((t) => t.id === templateId)) {
    return Promise.reject(new Error(`Unknown template: ${JSON.stringify(templateId)}`));
  }
  return runTemplateFixById(templateId, fixId, values, { ...defaultCheckDeps, ...deps });
}

/**
 * Write a recipe from template `templateId` and the form's `values`, and
 * return its id. Nothing is written unless the recipe validates, and an
 * existing recipe is never overwritten.
 */
export function createRecipeFromTemplate(
  templateId: string,
  values: Record<string, string>,
  ctx: TemplateContext,
  baseDir: string = hostRecipesDir(),
): string {
  const template = RECIPE_TEMPLATES.find((t) => t.id === templateId);
  if (!template) throw new Error(`Unknown template: ${JSON.stringify(templateId)}`);
  const recipe = template.recipe(values, ctx);
  const dir = recipeDir(recipe.id, baseDir);
  parseRecipe(recipe, dir);
  if (fs.existsSync(dir)) {
    throw new Error(`A recipe "${recipe.id}" already exists. Pick another name.`);
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    for (const [file, { content, mode }] of Object.entries(template.files)) {
      const target = path.join(dir, file);
      fs.writeFileSync(target, content, { mode });
      fs.chmodSync(target, mode);
    }
    writeRecipe(recipe, baseDir);
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  return recipe.id;
}
