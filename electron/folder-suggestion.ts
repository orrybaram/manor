import {
  JEV_MAX_BODY_BYTES,
  JEV_MAX_OPTION_CHARS,
  JEV_MAX_OPTIONS,
  JEV_OPTION_KEY_PATTERN,
  JEV_STATE_MAX_CHARS,
  type FolderPick,
  type JevPayload,
} from "../src/lib/jev-protocol";
import type { ProjectInfo, WorkspaceFolder } from "./projects/types";

/** The reserved option for "none of the folders fit". */
export const NO_FOLDER = "__none__";
/** Below this confidence a pick is not worth acting on. */
export const MIN_CONFIDENCE = 0.6;

const MAX_MEMBER_NAMES = 10;
/** Folder options; `NO_FOLDER` takes the last of the worker's slots. */
export const MAX_FOLDER_OPTIONS = JEV_MAX_OPTIONS - 1;
/** Leaves room for the envelope (`v`, `pub`, `ts`, `sig`) around `{ state, options }`. */
const MAX_PAYLOAD_BYTES = JEV_MAX_BODY_BYTES - 1024;

export interface FolderDraft {
  name: string;
  branchName?: string;
  agentPrompt?: string;
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
): JevPayload | null {
  const name = draft.name.trim();
  if (project.folders.length === 0 || !name) return null;

  const byId = new Map(project.folders.map((f) => [f.id, f]));
  const folders = project.folders
    .filter((f) => JEV_OPTION_KEY_PATTERN.test(f.id))
    .slice(0, MAX_FOLDER_OPTIONS)
    .map((folder) => ({
      id: folder.id,
      label: folderPathLabel(folder, byId),
      members: project.workspaces
        .filter((ws) => ws.folderId === folder.id)
        .slice(0, MAX_MEMBER_NAMES)
        .map((ws) => ws.name || ws.branch),
    }));

  // The instructions text lives in `relay/src/jev.ts`; only data goes from here.
  const state: JevPayload["state"] = {
    workspaceName: name.slice(0, JEV_STATE_MAX_CHARS.workspaceName),
  };
  const branchName = draft.branchName?.trim();
  if (branchName)
    state.branchName = branchName.slice(0, JEV_STATE_MAX_CHARS.branchName);
  const agentPrompt = draft.agentPrompt?.trim();
  if (agentPrompt)
    state.agentPrompt = agentPrompt.slice(0, JEV_STATE_MAX_CHARS.agentPrompt);

  // Within the worker's body limit: member lists go first, then the
  // trailing folders.
  const optionsFor = (withMembers: boolean, count: number) => {
    const options: Record<string, string> = {};
    for (const f of folders.slice(0, count)) {
      options[f.id] = describeFolder(f.label, withMembers ? f.members : []);
    }
    options[NO_FOLDER] = "Fits none of these folders";
    return options;
  };
  const fits = (options: Record<string, string>) =>
    Buffer.byteLength(JSON.stringify({ state, options })) <= MAX_PAYLOAD_BYTES;
  let options = optionsFor(true, folders.length);
  if (!fits(options)) options = optionsFor(false, folders.length);
  for (let count = folders.length - 1; !fits(options) && count > 0; count--) {
    options = optionsFor(false, count);
  }

  return { state, options };
}

/**
 * `Folder "<label>". Contains workspaces: a, b`, within the worker's
 * description limit: member names that don't fit are dropped.
 */
function describeFolder(label: string, members: string[]): string {
  let description = `Folder "${label}".`.slice(0, JEV_MAX_OPTION_CHARS);
  const prefix = " Contains workspaces: ";
  const fitting: string[] = [];
  for (const member of members) {
    const next = [...fitting, member].join(", ");
    if (
      description.length + prefix.length + next.length >
      JEV_MAX_OPTION_CHARS
    ) {
      break;
    }
    fitting.push(member);
  }
  if (fitting.length > 0) description += prefix + fitting.join(", ");
  return description;
}

/** The folder worth filing under, or null when the answer says not to. */
export function interpretFolderAnswer(
  answer: { choice: string; confidence: number },
  project: ProjectInfo,
): FolderPick | null {
  if (answer.choice === NO_FOLDER) return null;
  if (!(answer.confidence >= MIN_CONFIDENCE)) return null;
  if (!project.folders.some((f) => f.id === answer.choice)) return null;
  return { folderId: answer.choice, confidence: answer.confidence };
}
