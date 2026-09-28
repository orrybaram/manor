import { useState } from "react";

const STORAGE_KEY = "manor:deleteBranchOnWorktreeRemove";

function readPreference(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

/**
 * The "Also delete local branch" choice, remembered across deletes. Shared by
 * the single and bulk delete dialogs (ADR-190 §2) so both read and write the
 * same preference.
 */
export function useDeleteBranchPreference(): [boolean, (next: boolean) => void] {
  const [checked, setChecked] = useState(readPreference);
  const update = (next: boolean) => {
    setChecked(next);
    try {
      localStorage.setItem(STORAGE_KEY, String(next));
    } catch {
      // ignore
    }
  };
  return [checked, update];
}
