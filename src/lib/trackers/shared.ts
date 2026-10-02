/** ADR-202 §2: small helpers the tracker adapters share. */

import { useProjectStore, type LinkedIssue } from "../../store/project-store";
import { addErrorToast } from "../../store/toast-store";
import { extractImages } from "../task-images";
import type { TaskDetail, TaskRef } from "../tasks";

/** A hex colour from `gh` (no `#`) or Linear (with `#`) as CSS; undefined if unusable. */
export function cssHex(color: string | null | undefined): string | undefined {
  if (!color) return undefined;
  const hex = color.startsWith("#") ? color.slice(1) : color;
  return /^[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(hex) ? `#${hex}` : undefined;
}

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, "").toLowerCase();
}

/** Same task URL, ignoring trailing slashes and case; never true for a blank URL. */
export function sameUrl(a: string, b: string): boolean {
  return a !== "" && b !== "" && normalizeUrl(a) === normalizeUrl(b);
}

/** The URLs of the images embedded in a task body. */
export function imagesOf(body: string | null): string[] {
  return body ? extractImages(body).map((img) => img.url) : [];
}

/** A new agent's prompt for a task: its title, then its body. */
export function agentPrompt(ref: TaskRef, detail: TaskDetail | null): string {
  return ref.title + "\n\n" + (detail?.body ?? "");
}

/** Link `ref` to a workspace without blocking the caller; a failure is toasted. */
export function linkBestEffort(
  ref: TaskRef,
  projectId: string,
  workspacePath: string,
): void {
  const link: LinkedIssue = {
    id: ref.id,
    identifier: ref.displayId,
    title: ref.title,
    url: ref.url,
  };
  useProjectStore
    .getState()
    .linkIssueToWorkspace(projectId, workspacePath, link)
    .catch((err) => {
      addErrorToast(`link-issue-error-${ref.id}`, "Failed to link task", err);
    });
}

/** Unlink `ref` from a workspace and reload projects; throws on failure. Links of both trackers live on the Linear API. */
export async function unlinkTask(
  ref: TaskRef,
  projectId: string,
  workspacePath: string,
): Promise<void> {
  await window.electronAPI.linear.unlinkIssueFromWorkspace(
    projectId,
    workspacePath,
    ref.id,
  );
  await useProjectStore.getState().loadProjects();
}
