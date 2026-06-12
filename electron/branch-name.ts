// Intentionally mirrors `src/utils/branch-name.ts`. The renderer and main
// process are separate TS compile units (`rootDir: electron`), so they cannot
// share a module — keep these two functions identical to that file.

/**
 * Enforce `git check-ref-format` rules while preserving case.
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
 * Lowercase filesystem slug.
 */
export function toDirSlug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}
