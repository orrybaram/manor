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

/**
 * One option for a field (ADR-234 D6): a `choice` field's, listed by main
 * (`checkTemplate`), or a `size` field's, fixed in the template.
 */
export interface Choice {
  /** What the field's answer becomes when this is picked. */
  value: string;
  label: string;
  /** A second line that tells similar options apart, e.g. a cluster's server. */
  hint?: string;
}

/**
 * How the form renders a field (ADR-234 D6): free `text` (the default), a
 * `choice` among options main lists (`TemplateCheckResult.choices`; the user
 * may still type one that isn't listed), or a `size` among the template's
 * own fixed `options`.
 */
export type FormFieldType = "text" | "choice" | "size";

/** One answer the form asks for. */
export interface FormField {
  /** The key of the answer in `values`. */
  key: string;
  label: string;
  description?: string;
  /** A function is called each time the form is described (a fresh name). */
  default?: string | ((ctx: TemplateContext) => string);
  required?: boolean;
  /** Absent means `text`. */
  type?: FormFieldType;
  /** Shown under the form's "Advanced" disclosure rather than up front (ADR-234 D7). */
  advanced?: boolean;
  /** A `size` field's options, in the order shown. */
  options?: Choice[];
}

/**
 * A check's one fix (ADR-234 D8), by what carries it out:
 *
 * - `run`: main does it — `hosts.runTemplateFix(templateId, id, values)`
 *   opens an app or starts a background pull or build; the next
 *   `checkTemplate` shows the result (`busy` while a job runs).
 * - `url`: the renderer opens `href` in the browser (a `Link`): "Get Docker
 *   Desktop", "Install kubectl".
 * - `set`: the renderer sets field `key` to `value` ("Use namespace dev",
 *   "Use storage class standard"); no IPC.
 *
 * A shell command is only ever a check's `detail`, never a fix.
 */
export type TemplateFix =
  | { kind: "run"; id: string; label: string }
  | { kind: "url"; label: string; href: string }
  | { kind: "set"; label: string; key: string; value: string };

/**
 * One row of a template's readiness checklist (ADR-234 D8): a plain
 * sentence, its state, and at most one fix. Later checks are `todo` until
 * the earlier ones pass.
 */
export interface TemplateCheck {
  id: string;
  state: "ok" | "bad" | "todo" | "busy";
  /** A plain sentence: "Docker isn't running". */
  title: string;
  /** "Context desktop-linux", "280 of 450 MB". A shell command is only ever shown here. */
  detail?: string;
  fix?: TemplateFix;
}

/**
 * What `hosts.checkTemplate` answers for a template and the form's values
 * (ADR-234 D6): its checklist, and the options of its `choice` fields, by
 * field key. One round trip per refresh.
 */
export interface TemplateCheckResult {
  checks: TemplateCheck[];
  choices: Record<string, Choice[]>;
  /**
   * Answers to start a field with, by field key (e.g. the cluster the last
   * Kubernetes recipe used). The form applies one only while the field is
   * still blank and the user hasn't touched it.
   */
  defaults?: Record<string, string>;
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
  /**
   * The keys of the fields that differ for each host made from a profile
   * (ADR-235 D1): a profile never stores them, and its editor hides them.
   */
  perHost: string[];
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
  /** As `RecipeTemplate.perHost`. */
  perHost: string[];
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
