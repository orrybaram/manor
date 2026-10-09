/**
 * Jev, provided by Manor through the relay (ADR-211), as the `jev` namespace
 * of the handler table.
 *
 * There is no key on this side to protect: `JevClient` signs with the relay
 * identity and the TypeSafe key lives on the relay Worker. `suggestFolder`
 * hands back only the pick, so it crosses like any other read.
 */

import type { FolderPick } from "../../../src/lib/jev-protocol";
import { assertString } from "../../ipc-validate";
import {
  buildFolderQuestion,
  interpretFolderAnswer,
  type FolderDraft,
} from "../../folder-suggestion";
import { method, type HandlerCtx } from "../method";

/**
 * The folder Jev would file a new workspace under. A malformed call is
 * rejected like any other; past validation a suggestion is a nicety, so
 * turned off, nothing to choose between, or any failure is `null`, and a
 * failure is logged.
 */
export async function jevSuggestFolder(
  ctx: HandlerCtx,
  projectId: string,
  draft: FolderDraft,
): Promise<FolderPick | null> {
  assertString(projectId, "projectId");
  const value: unknown = draft;
  if (!value || typeof value !== "object") {
    throw new Error("draft: expected object");
  }
  const { name, branchName, agentPrompt } = value as Record<string, unknown>;
  assertString(name, "draft.name");
  if (branchName !== undefined) assertString(branchName, "draft.branchName");
  if (agentPrompt !== undefined) assertString(agentPrompt, "draft.agentPrompt");

  try {
    const { jevClient, preferencesManager, projectManager } = ctx.deps;
    if (preferencesManager.get("folderSuggestionsEnabled") === false) {
      return null;
    }

    const projects = await projectManager.getProjects();
    const project = projects.find((p) => p.id === projectId);
    if (!project) return null;

    const question = buildFolderQuestion(project, {
      name,
      branchName,
      agentPrompt,
    });
    if (!question) return null;

    const answer = await jevClient.suggest(question);
    return answer ? interpretFolderAnswer(answer, project) : null;
  } catch (err) {
    console.error("[jev] folder suggestion failed:", err);
    return null;
  }
}

export const jev = {
  suggestFolder: method(jevSuggestFolder),
};
