/**
 * Whether a search matches some text fields: every whitespace-separated word
 * appears, ignoring case, in at least one of them (each word may sit in a
 * different field).
 */
export function matchesQueryWords(
  fields: ReadonlyArray<string | null | undefined>,
  query: string,
): boolean {
  const haystack = fields.filter(Boolean).join("\n").toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

/**
 * Whether an agent matches a search: every whitespace-separated word appears,
 * ignoring case, in its name, project name or workspace path.
 */
export function matchesAgentQuery(
  agent: {
    name: string | null;
    projectName: string | null;
    workspacePath: string | null;
  },
  query: string,
): boolean {
  return matchesQueryWords([agent.name, agent.projectName, agent.workspacePath], query);
}
