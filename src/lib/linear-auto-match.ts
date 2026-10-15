/**
 * Give every project with no Linear team the team its name matches, once
 * Linear is connected (ADR-228 D10).
 *
 * The match needs the token, so `linear.autoMatch` is a delegated read: the
 * router has whichever server holds Linear answer it. The writes are each
 * project's own: an ungrouped project's team goes to its own source
 * (`linear.associateProject`, by project), and a grouped one's to its group,
 * which is the desktop's (ADR-192, ADR-227 D2). So a server that answered
 * the match never writes another server's projects.
 */

import type { ElectronAPI, LinearAssociation } from "../electron";
import type { ProjectInfo } from "../store/project-store";

/** How many projects got a team. */
export async function autoMatchLinearTeams(
  projects: readonly ProjectInfo[],
  api: ElectronAPI = window.electronAPI,
): Promise<number> {
  const unmatched = projects.filter((p) => p.linearAssociations.length === 0);
  if (unmatched.length === 0) return 0;
  const matches = await api.linear.autoMatch(unmatched.map(({ id, name }) => ({ id, name })));
  const groupsDone = new Set<string>();
  const writes = unmatched.map(async (project): Promise<boolean> => {
    const association: LinearAssociation | undefined = matches[project.id];
    if (!association) return false;
    try {
      const group = project.group;
      if (!group) return await api.linear.associateProject(project.id, association);
      if (groupsDone.has(group.id)) return true;
      groupsDone.add(group.id);
      await api.projects.updateGroup(group.id, { linearAssociations: [association] });
      return true;
    } catch (err) {
      // One project's server refusing leaves the others matched.
      console.warn(`[linear] could not give ${project.name} its team:`, err);
      return false;
    }
  });
  return (await Promise.all(writes)).filter(Boolean).length;
}
