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
  const haystack = [agent.name, agent.projectName, agent.workspacePath]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}
