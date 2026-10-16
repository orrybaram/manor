import { create } from "zustand";
import type { HostProfile } from "../electron.d";

/** What `hostProfiles.save` takes (ADR-235 D1). */
export type HostProfileSave = Parameters<Window["electronAPI"]["hostProfiles"]["save"]>[0];

export type ProfileEditorRequest = {
  /** The profile to edit; absent makes a new one. */
  profile?: HostProfile;
  /** Called with the profile as saved: Add Project picks it up by id. */
  onSaved?: (profile: HostProfile) => void;
};

interface HostProfileState {
  profiles: HostProfile[];
  /** Null while the profile editor is closed. */
  editor: ProfileEditorRequest | null;
  refresh: () => Promise<void>;
  save: (input: HostProfileSave) => Promise<HostProfile>;
  remove: (profileId: string) => Promise<void>;
  openEditor: (request?: ProfileEditorRequest) => void;
  closeEditor: () => void;
}

export const useHostProfileStore = create<HostProfileState>((set, get) => {
  // Main says when a profile is saved or removed, from here or elsewhere.
  window.electronAPI?.hostProfiles?.onChanged(() => void get().refresh());
  // Only the latest answer is kept.
  let request = 0;

  return {
    profiles: [],
    editor: null,

    refresh: async () => {
      const mine = ++request;
      try {
        const profiles = await window.electronAPI.hostProfiles.list();
        if (mine === request) set({ profiles });
      } catch {
        // Keep what is shown; the next change asks again.
      }
    },

    save: (input) => window.electronAPI.hostProfiles.save(input),
    remove: (profileId) => window.electronAPI.hostProfiles.remove(profileId),

    openEditor: (editor = {}) => set({ editor }),
    closeEditor: () => set({ editor: null }),
  };
});

/**
 * Opens the profile editor (ADR-235 D2) from anywhere; `onSaved` gets the
 * saved profile back. Needs `ProfileEditorDialog` mounted.
 */
export function openProfileEditor(request: ProfileEditorRequest = {}): void {
  useHostProfileStore.getState().openEditor(request);
}
