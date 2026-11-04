import { create } from "zustand";
import { AppPreferences } from "../electron.d";
import { liveValue } from "../bridge/resync";
import { isWebApp } from "../lib/platform";

interface PreferencesState {
  preferences: AppPreferences;
  loaded: boolean;
  set: (
    key: keyof AppPreferences,
    value: AppPreferences[keyof AppPreferences],
  ) => void;
}

/** This window's writes the main process hasn't answered yet, by key. */
const unanswered = new Map<keyof AppPreferences, number>();

/**
 * What main says, except for keys this window has a write on the way for:
 * main's answer to an earlier keystroke would take back a later one.
 */
function overUnanswered(
  theirs: AppPreferences,
  ours: AppPreferences,
): AppPreferences {
  const merged: Record<string, unknown> = { ...theirs };
  for (const key of unanswered.keys()) merged[key] = ours[key];
  return merged as unknown as AppPreferences;
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
  notifyOnGithubReviewRequested: true,
  notifyOnGithubMentioned: true,
  notifyOnGithubAssigned: true,
  notifyOnGithubTeamMentioned: false,
  notifyOnGithubSecurityAlert: false,
  notifyOnLinearAssigned: true,
  notifyOnLinearMentioned: true,
  notifyOnLinearComments: false,
  notifyOnLinearStatusChanges: false,
  notifyOnLinearTriage: false,
  notifyOnLinearReviews: false,
  notifyOnLinearReactions: false,
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
  chatFontFamily: "",
  chatFontSize: 14,
  remoteControlOnLaunch: false,
  deleteWorkspaceAfterMerge: true,
  mergeCleanups: {},
  promptOverrides: {},
};

export const usePreferencesStore = create<PreferencesState>((set, get) => {
  if (window.electronAPI?.preferences) {
    liveValue(
      () => window.electronAPI.preferences.getAll(),
      (cb) => window.electronAPI.preferences.onChange(cb),
      (preferences) =>
        set({
          preferences: overUnanswered(preferences, get().preferences),
          loaded: true,
        }),
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
      const write = window.electronAPI?.preferences.set(key, value);
      if (!write) return;
      unanswered.set(key, (unanswered.get(key) ?? 0) + 1);
      const answered = () => {
        const left = (unanswered.get(key) ?? 1) - 1;
        if (left > 0) unanswered.set(key, left);
        else unanswered.delete(key);
      };
      void Promise.resolve(write).then(answered, answered);
    },
  };
});

/** How long a terminal waits on preferences before opening at the defaults. */
const PREFERENCES_TIMEOUT_MS = 2_000;

/** Set once a wait has timed out: a read that failed is not waited on again. */
let gaveUp = false;

/**
 * Resolve once preferences have been read, or when waiting longer stops being
 * worth a blank pane. A terminal opens after this so it is created in the
 * font from Settings: one opened at the default and corrected a moment later
 * would tell its pty a size the pane never showed. Nothing to wait for in a
 * phone or browser tab, which ignores the font preferences
 * (`useTerminalFont`).
 */
export function whenPreferencesLoaded(): Promise<void> {
  if (gaveUp || isWebApp() || usePreferencesStore.getState().loaded) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      unsubscribe();
      resolve();
    };
    const timer = setTimeout(() => {
      gaveUp = true;
      done();
    }, PREFERENCES_TIMEOUT_MS);
    const unsubscribe = usePreferencesStore.subscribe((s) => {
      if (s.loaded) done();
    });
  });
}
