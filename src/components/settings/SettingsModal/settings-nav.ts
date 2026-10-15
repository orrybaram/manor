import { createContext, useContext } from "react";
import type { SettingsPage } from "./settings-search";

/**
 * Move the settings modal to `page`, scrolled to `section` when given: how
 * one page links to another's section (the project Host section to the
 * Hosts page, a host on the Hosts page to its Remote control section).
 */
export type GoToSettings = (page: SettingsPage, section?: string) => void;

export const SettingsNavContext = createContext<GoToSettings | null>(null);

/** `GoToSettings` for the open modal. Throws outside `SettingsModal`. */
export function useSettingsNav(): GoToSettings {
  const goTo = useContext(SettingsNavContext);
  if (!goTo) throw new Error("useSettingsNav must be used inside SettingsModal");
  return goTo;
}

/**
 * The section a link or search is about to scroll to, until it has: lets a
 * collapsed section (a host row on the Hosts page) open itself first.
 */
export const SettingsJumpContext = createContext<string | null>(null);

/** The section being jumped to, or null. */
export function useSettingsJump(): string | null {
  return useContext(SettingsJumpContext);
}
