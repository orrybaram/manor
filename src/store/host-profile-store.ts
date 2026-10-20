import { create } from "zustand";
import type { HostProfile } from "../electron.d";

/** What `hostProfiles.save` takes. */
export type HostProfileSave = Parameters<Window["electronAPI"]["hostProfiles"]["save"]>[0];

/** What `hostProfiles.setSignIn` takes. Tokens pass through; nothing keeps them. */
export type HostProfileSignIn = Parameters<Window["electronAPI"]["hostProfiles"]["setSignIn"]>[1];

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
  /** Writes tokens into the cluster; resolves to the profile with its new metadata. */
  setSignIn: (profileId: string, input: HostProfileSignIn) => Promise<HostProfile>;
  removeSignIn: (profileId: string, which: "github" | "claude") => Promise<HostProfile>;
  /** Names of the pods restarted. */
  restartPods: (profileId: string) => Promise<string[]>;
  openEditor: (request?: ProfileEditorRequest) => void;
  closeEditor: () => void;
}

export const useHostProfileStore = create<HostProfileState>((set, get) => {
  // Main says when a profile is saved or removed, from here or elsewhere.
  window.electronAPI?.hostProfiles?.onChanged(() => void get().refresh());
  // Only the latest answer is kept.
  let request = 0;
  // A profile as main just answered it, shown at once (main's change event
  // re-lists after).
  const putProfile = (saved: HostProfile): HostProfile => {
    set((s) => ({
      profiles: s.profiles.some((p) => p.id === saved.id)
        ? s.profiles.map((p) => (p.id === saved.id ? saved : p))
        : [...s.profiles, saved],
    }));
    return saved;
  };

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

    setSignIn: async (profileId, input) =>
      putProfile(await window.electronAPI.hostProfiles.setSignIn(profileId, input)),
    removeSignIn: async (profileId, which) =>
      putProfile(await window.electronAPI.hostProfiles.removeSignIn(profileId, which)),
    restartPods: async (profileId) =>
      (await window.electronAPI.hostProfiles.restartPods(profileId)).restarted,

    openEditor: (editor = {}) => set({ editor }),
    closeEditor: () => set({ editor: null }),
  };
});

/**
 * Opens the profile editor from anywhere; `onSaved` gets the
 * saved profile back. Needs `ProfileEditorDialog` mounted.
 */
export function openProfileEditor(request: ProfileEditorRequest = {}): void {
  useHostProfileStore.getState().openEditor(request);
}
