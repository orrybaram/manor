import { useProjectStore } from "../store/project-store";
import { ownerOf } from "../lib/workspace-directory";

/** The id of the project that has the workspace keyed `key`, if any. */
export function useWorkspaceProjectId(key: string | null | undefined): string | undefined {
  return useProjectStore((s) => ownerOf(s.projects, key)?.id);
}
