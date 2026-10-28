import { create } from "zustand";
import { AppPreferences } from "../electron.d";
import { liveValue } from "../bridge/resync";

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
  notifyOnPrComment: true,
  notifyOnBotPrComments: false,
  notifyOnOwnPrComments: false,
  notifyOnPrApproved: true,
  notifyOnPrChangesRequested: true,
  notifyOnPrChecksFailed: true,
  notificationSound: "Glass",
  defaultEditor: "",
  editorIsTerminal: false,
  diffOpensInNewPanel: true,
  agentRetentionDays: 90,
  agentPruneNoticeShown: false,
  statsEnabled: true,
  folderSuggestionsEnabled: true,
  achievementTitle: null,
  revealedBadges: [],
  halloweenEffects: true,
};

export const usePreferencesStore = create<PreferencesState>((set) => {
  if (window.electronAPI?.preferences) {
    liveValue(
      () => window.electronAPI.preferences.getAll(),
      (cb) => window.electronAPI.preferences.onChange(cb),
      (preferences) => set({ preferences, loaded: true }),
    );
  }

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
