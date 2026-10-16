/**
 * What a bundled recipe template is (ADR-229 D8): a short form, the scripts
 * it writes, and the `recipe.json` it makes from the form's answers.
 */

import type { Recipe } from "../recipes";

/** What a template needs from the running app when it is described or written. */
export interface TemplateContext {
  /** Manor's version: the host image is tagged with it. */
  appVersion: string;
}

/** The repository of the published host image (built by `release.yml`). */
export const HOST_IMAGE_REPOSITORY = "ghcr.io/orrybaram/manor-host";

/** The image a new host starts from: the published one, pinned to this app. */
export function defaultHostImage(ctx: TemplateContext): string {
  return `${HOST_IMAGE_REPOSITORY}:${ctx.appVersion.replace(/^v/, "")}`;
}

/** One answer the form asks for. */
export interface FormField {
  /** The key of the answer in `values`. */
  key: string;
  label: string;
  description?: string;
  /** A function is called each time the form is described (a fresh name). */
  default?: string | ((ctx: TemplateContext) => string);
  required?: boolean;
}

/** One script a template writes into the recipe's directory. */
export interface TemplateFile {
  content: string;
  /** Its file mode, e.g. `0o755`. */
  mode: number;
}

export interface RecipeTemplate {
  id: string;
  name: string;
  description: string;
  fields: FormField[];
  /** File name in the recipe's directory -> its content. */
  files: Record<string, TemplateFile>;
  /** The recipe for `values`; throws if an answer is not acceptable. */
  recipe: (values: Record<string, string>, ctx: TemplateContext) => Recipe;
}

/** A template as the form needs it: no scripts, defaults resolved. */
export interface TemplateInfo {
  id: string;
  name: string;
  description: string;
  fields: Array<Omit<FormField, "default"> & { default?: string }>;
}

/** `manor-` and six random hex digits: a name that is unlikely to be taken. */
export function shortName(): string {
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  return `manor-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * `values[key]` trimmed, or `fallback` when it is blank. Everything a script
 * receives is checked here, since the values reach it as environment
 * variables and, in the Kubernetes manifest, as text.
 */
export function answer(
  values: Record<string, string>,
  key: string,
  opts: { pattern: RegExp; what: string; fallback?: string },
): string {
  const raw = (values[key] ?? "").trim();
  if (raw === "") {
    if (opts.fallback === undefined) throw new Error(`${opts.what} is required`);
    return opts.fallback;
  }
  const value = raw;
  if (!opts.pattern.test(value)) throw new Error(`${opts.what} is not valid: ${JSON.stringify(value)}`);
  return value;
}

/** A lowercase DNS-style label: container, namespace and workload names. */
export const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
/** An image reference: no whitespace or shell metacharacters. */
export const IMAGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\-/:@]{0,254}$/;
/** A docker or kubectl context name. */
export const CONTEXT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@:/-]{0,127}$/;
