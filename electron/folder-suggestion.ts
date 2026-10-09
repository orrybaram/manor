import type { ProjectInfo, WorkspaceFolder } from "./projects/types";

/** The reserved option for "none of the folders fit". */
export const NO_FOLDER = "__none__";
/** Below this confidence a pick is not worth acting on. */
export const MIN_CONFIDENCE = 0.6;

const MAX_MEMBER_NAMES = 10;
const MAX_PROMPT_CHARS = 2000;

export interface FolderDraft {
  name: string;
  branchName?: string;
  agentPrompt?: string;
}

export interface FolderQuestion {
  state: Record<string, string>;
  instructions: string;
  options: Record<string, string>;
}

/** "Parent / Child" for a folder, root first. A cycle stops the walk. */
function folderPathLabel(
  folder: WorkspaceFolder,
  byId: Map<string, WorkspaceFolder>,
): string {
  const names = [folder.name];
  const seen = new Set([folder.id]);
  let parentId = folder.parentId;
  while (parentId && !seen.has(parentId)) {
    const parent = byId.get(parentId);
    if (!parent) break;
    seen.add(parent.id);
    names.unshift(parent.name);
    parentId = parent.parentId;
  }
  return names.join(" / ");
}

/**
 * The Jev question for filing `draft` under one of `project`'s folders, or
 * null when there is nothing to choose between or nothing to describe.
 */
export function buildFolderQuestion(
  project: ProjectInfo,
  draft: FolderDraft,
): FolderQuestion | null {
  const name = draft.name.trim();
  if (project.folders.length === 0 || !name) return null;

  const byId = new Map(project.folders.map((f) => [f.id, f]));
  const options: Record<string, string> = {};
  for (const folder of project.folders) {
    const members = project.workspaces
      .filter((ws) => ws.folderId === folder.id)
      .slice(0, MAX_MEMBER_NAMES)
      .map((ws) => ws.name || ws.branch);
    let description = `Folder "${folderPathLabel(folder, byId)}".`;
    if (members.length > 0) {
      description += ` Contains workspaces: ${members.join(", ")}`;
    }
    options[folder.id] = description;
  }
  options[NO_FOLDER] = "Fits none of these folders";

  const state: Record<string, string> = { workspaceName: name };
  const branchName = draft.branchName?.trim();
  if (branchName) state.branchName = branchName;
  const agentPrompt = draft.agentPrompt?.trim();
  if (agentPrompt) state.agentPrompt = agentPrompt.slice(0, MAX_PROMPT_CHARS);

  return {
    state,
    instructions:
      "Which sidebar folder should this new workspace be filed under? Folders group related workspaces; judge by what the folder's existing workspaces are about.",
    options,
  };
}

/** The folder worth filing under, or null when the answer says not to. */
export function interpretFolderAnswer(
  answer: { choice: string; confidence: number },
  project: ProjectInfo,
): { folderId: string; confidence: number } | null {
  if (answer.choice === NO_FOLDER) return null;
  if (!(answer.confidence >= MIN_CONFIDENCE)) return null;
  if (!project.folders.some((f) => f.id === answer.choice)) return null;
  return { folderId: answer.choice, confidence: answer.confidence };
}
