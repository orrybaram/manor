// Canonical branch-name and directory-slug helpers.
//
// `sanitizeBranchName` enforces `git check-ref-format` rules while preserving
// the user's intended casing. `toDirSlug` produces a lowercase filesystem slug.
// `branchesEqual` does case-insensitive matching (never feed its inputs to git).

/**
 * Enforce `git check-ref-format` rules while preserving case.
 *
 * - trims surrounding whitespace
 * - converts internal whitespace runs to a single `-`
 * - strips git-forbidden ref characters and the `@{`/`}` sequence chars
 * - collapses `..` -> `.`, `//` -> `/`, repeated `-` -> `-`
 * - keeps `/` so namespaced branches survive
 * - trims leading/trailing `-`, `.`, `/`
 * - drops a trailing `.lock` (case-insensitive)
 * - does NOT lowercase
 */
export function sanitizeBranchName(input: string): string {
  let result = input.trim();

  // Emoji belong in display names, not git refs.
  // eslint-disable-next-line no-misleading-character-class
  result = result.replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\u{FE0F}\u{200D}\u{20E3}]/gu, "");
  result = result.trim();

  // Internal whitespace runs -> single hyphen.
  result = result.replace(/\s+/g, "-");

  // Strip git-forbidden characters: ~ ^ : ? * [ \, the `{` `}` `@` sequence
  // characters, and ASCII control chars.
  // eslint-disable-next-line no-control-regex
  result = result.replace(/[~^:?*[\\{}@\x00-\x1f\x7f]/g, "");

  // Collapse repeated separators.
  result = result.replace(/\.{2,}/g, ".");
  result = result.replace(/\/{2,}/g, "/");
  result = result.replace(/-{2,}/g, "-");

  // Drop a trailing `.lock` (case-insensitive).
  result = result.replace(/\.lock$/i, "");

  // Trim leading/trailing separators.
  result = result.replace(/^[-./]+|[-./]+$/g, "");

  return result;
}

/**
 * Lowercase filesystem slug. Ported from the existing `slugify`.
 */
export function toDirSlug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Case-insensitive equality, used only for matching — never for passing to git.
 * Returns `false` if either value is null/undefined.
 */
export function branchesEqual(
  a?: string | null,
  b?: string | null,
): boolean {
  if (a == null || b == null) return false;
  return a.toLowerCase() === b.toLowerCase();
}

const PROMPT_NAME_WORDS = 6;
const PROMPT_NAME_MAX = 40;

/**
 * A worktree name for a new agent, from its prompt: the first few words as a
 * dir slug, cut at a dash boundary to fit, `agent` when nothing is left, and
 * suffixed `-2`, `-3`… until it isn't in `taken`.
 */
export function worktreeNameFromPrompt(prompt: string, taken: ReadonlySet<string>): string {
  const words = prompt.trim().split(/\s+/).slice(0, PROMPT_NAME_WORDS).join(" ");
  let slug = toDirSlug(words);
  if (slug.length > PROMPT_NAME_MAX) {
    const cut = slug.slice(0, PROMPT_NAME_MAX + 1);
    const dash = cut.lastIndexOf("-");
    slug = (dash > 0 ? cut.slice(0, dash) : cut.slice(0, PROMPT_NAME_MAX)).replace(/-+$/, "");
  }
  const base = slug || "agent";
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
