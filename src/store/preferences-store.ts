import { create } from "zustand";
import { AppPreferences } from "../electron.d";

interface PreferencesState {
  preferences: AppPreferences;
  loaded: boolean;
  set: (
    key: keyof AppPreferences,
    value: AppPreferences[keyof AppPreferences],
  ) => void;
}

const defaultPreferences: AppPreferences = {
  dockBadgeEnabled: true,
  notifyOnResponse: true,
  notifyOnRequiresInput: true,
  notificationSound: "Glass",
  defaultEditor: "",
  editorIsTerminal: false,
  diffOpensInNewPanel: true,
};

export const usePreferencesStore = create<PreferencesState>((set) => {
  // Load initial preferences on store creation
  window.electronAPI?.preferences
    .getAll()
    .then((preferences) => {
      set({ preferences, loaded: true });
    })
    .catch(() => {});

  // Subscribe to live preference updates
  window.electronAPI?.preferences.onChange((preferences) => {
    set({ preferences });
  });

  return {
    preferences: defaultPreferences,
    loaded: false,

    set: (key, value) => {
      // Optimistically update local state
      set((s) => ({
        preferences: { ...s.preferences, [key]: value },
      }));
      // Persist to main process
      window.electronAPI?.preferences.set(key, value);
    },
  };
});
