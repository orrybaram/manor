export type FolderSuggestion = { folderId: string; confidence: number };

type SuggestGate = {
  jevConnected: boolean;
  folderTouched: boolean;
  initialFolderId: string | null;
  activeProjectId: string;
  folderCount: number;
  name: string;
};

/** Whether the dialog should ask Jev for a folder right now. */
export function shouldSuggest(gate: SuggestGate): boolean {
  return (
    gate.jevConnected &&
    !gate.folderTouched &&
    gate.initialFolderId == null &&
    !!gate.activeProjectId &&
    gate.folderCount > 0 &&
    gate.name.trim().length > 0
  );
}

type Pick = { folderId: string | null; suggestion: FolderSuggestion | null };

/**
 * Fold a suggestion reply into the current pick. A hit replaces it; a miss
 * keeps a hand-made pick but drops a folder an earlier suggestion chose, so
 * a stale guess doesn't stick once the draft means something else.
 */
export function applySuggestionResult(current: Pick, result: FolderSuggestion | null): Pick {
  if (result) return { folderId: result.folderId, suggestion: result };
  if (current.suggestion && current.folderId === current.suggestion.folderId) {
    return { folderId: null, suggestion: null };
  }
  return { folderId: current.folderId, suggestion: null };
}
