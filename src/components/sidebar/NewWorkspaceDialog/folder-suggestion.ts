import type { FolderPick } from "../../../lib/jev-protocol";

/** The folder the dialog has, and the suggestion it came from, if any. */
export type FolderChoice = {
  folderId: string | null;
  suggestion: FolderPick | null;
};

/**
 * What a suggestion is asked for: the draft as it will be once the calling
 * handler's state lands, and the choice a reply would replace.
 */
export type SuggestSnapshot = {
  projectId: string;
  folderCount: number;
  name: string;
  branchName: string;
  /** Empty while the agent section is closed: a collapsed prompt says nothing. */
  agentPrompt: string;
  folderTouched: boolean;
  choice: FolderChoice;
};

type SuggestGate = Pick<
  SuggestSnapshot,
  "projectId" | "folderCount" | "name" | "folderTouched"
> & {
  suggestionsEnabled: boolean;
  initialFolderId: string | null;
};

/** Whether the dialog should ask Jev for a folder right now. */
export function shouldSuggest(gate: SuggestGate): boolean {
  return (
    gate.suggestionsEnabled &&
    !gate.folderTouched &&
    gate.initialFolderId == null &&
    !!gate.projectId &&
    gate.folderCount > 0 &&
    gate.name.trim().length > 0
  );
}

/**
 * Fold a suggestion reply into the current choice. A hit replaces it; a miss
 * keeps a hand-made pick but drops a folder an earlier suggestion chose, so
 * a stale guess doesn't stick once the draft means something else.
 */
export function applySuggestionResult(
  current: FolderChoice,
  result: FolderPick | null,
): FolderChoice {
  if (result) return { folderId: result.folderId, suggestion: result };
  if (current.suggestion && current.folderId === current.suggestion.folderId) {
    return { folderId: null, suggestion: null };
  }
  return { folderId: current.folderId, suggestion: null };
}
