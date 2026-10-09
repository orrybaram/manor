/**
 * TypeSafe's Jev decision model (ADR-210), as the `typesafe` namespace of the
 * handler table.
 *
 * **The key never crosses.** `TypeSafeManager` keeps it in `safeStorage`;
 * `typesafeConnect` is the one handler that takes a raw key, so it and
 * `disconnect` are `localOnly`, the same shape as `linear.connect`.
 * `suggestFolder` runs on the host's key and hands back only the pick.
 */

import { assertString } from "../../ipc-validate";
import {
  buildFolderQuestion,
  interpretFolderAnswer,
  type FolderDraft,
} from "../../folder-suggestion";
import { method, type HandlerCtx } from "../method";

export function typesafeIsConnected(ctx: HandlerCtx): boolean {
  return ctx.deps.typesafeManager.isConnected();
}

/**
 * Save the key, then prove it: `verify()` is an authenticated call, and a key
 * that fails it is cleared rather than left looking connected, as with
 * `linearConnect`.
 */
export async function typesafeConnect(
  ctx: HandlerCtx,
  apiKey: string,
): Promise<void> {
  assertString(apiKey, "apiKey");
  ctx.deps.typesafeManager.saveKey(apiKey);
  try {
    await ctx.deps.typesafeManager.verify();
  } catch (err) {
    ctx.deps.typesafeManager.clearKey();
    throw err;
  }
}

export function typesafeDisconnect(ctx: HandlerCtx): void {
  ctx.deps.typesafeManager.clearKey();
}

/**
 * The folder Jev would file a new workspace under. A suggestion is a
 * nicety, so this never throws: no key, nothing to choose between, or any
 * failure along the way is `null`, and a failure is logged.
 */
export async function typesafeSuggestFolder(
  ctx: HandlerCtx,
  projectId: string,
  draft: FolderDraft,
): Promise<{ folderId: string; confidence: number } | null> {
  try {
    assertString(projectId, "projectId");
    const d: unknown = draft;
    if (!d || typeof d !== "object") throw new Error("draft: expected object");
    const { name, branchName, agentPrompt } = d as Record<string, unknown>;
    assertString(name, "draft.name");
    if (branchName !== undefined) assertString(branchName, "draft.branchName");
    if (agentPrompt !== undefined) {
      assertString(agentPrompt, "draft.agentPrompt");
    }

    const { typesafeManager, projectManager } = ctx.deps;
    if (!typesafeManager.isConnected()) return null;

    const projects = await projectManager.getProjects();
    const project = projects.find((p) => p.id === projectId);
    if (!project) return null;

    const question = buildFolderQuestion(project, {
      name,
      branchName,
      agentPrompt,
    });
    if (!question) return null;

    const answer = await typesafeManager.choice(question);
    return interpretFolderAnswer(answer, project);
  } catch (err) {
    console.error("[typesafe] folder suggestion failed:", err);
    return null;
  }
}

export const typesafe = {
  isConnected: method(typesafeIsConnected),
  connect: method(typesafeConnect, { localOnly: true, secretFirstArg: true }),
  disconnect: method(typesafeDisconnect, { localOnly: true }),
  suggestFolder: method(typesafeSuggestFolder),
};
