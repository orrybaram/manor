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
  deskChatByDefault: false,
  agentRetentionDays: 90,
  agentPruneNoticeShown: false,
  statsEnabled: true,
  folderSuggestionsEnabled: true,
  achievementTitle: null,
  revealedBadges: [],
  halloweenEffects: true,
  terminalFontFamily: "",
  terminalFontSize: 13,
  editorFontFamily: "",
  editorFontSize: 12,
  remoteControlOnLaunch: false,
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

/** How long a terminal waits on preferences before opening at the defaults. */
const PREFERENCES_TIMEOUT_MS = 2_000;

/**
 * Resolve once preferences have been read, or when waiting longer stops being
 * worth a blank pane. A terminal opens after this so it is created in the
 * font from Settings: one opened at the default and corrected a moment later
 * would tell its pty a size the pane never showed.
 */
export function whenPreferencesLoaded(): Promise<void> {
  if (usePreferencesStore.getState().loaded) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      unsubscribe();
      resolve();
    };
    const timer = setTimeout(done, PREFERENCES_TIMEOUT_MS);
    const unsubscribe = usePreferencesStore.subscribe((s) => {
      if (s.loaded) done();
    });
  });
}
