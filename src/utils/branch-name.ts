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
