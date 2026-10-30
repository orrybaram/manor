import { useEffect } from "react";
import { useProjectStore } from "../../../store/project-store";
import { useThemeStore } from "../../../store/theme-store";

/** The global theme and each project's, as Settings found or left them. */
export type ThemePicks = {
  global: string;
  projects: Record<string, string | null>;
};

function currentPicks(): ThemePicks {
  return {
    global: useThemeStore.getState().selectedThemeName,
    projects: Object.fromEntries(
      useProjectStore.getState().projects.map((p) => [p.id, p.themeName]),
    ),
  };
}

/**
 * The themes to count as recent when Settings closes: those picked while it
 * was open and still picked now. A tile clicked while browsing and then left
 * behind isn't one, nor is a theme that was already on when Settings opened.
 * Oldest first, so the global pick lands newest.
 */
export function keptThemePicks(before: ThemePicks, after: ThemePicks): string[] {
  const kept = new Set<string>();
  for (const [id, name] of Object.entries(after.projects)) {
    if (name !== null && name !== before.projects[id]) kept.add(name);
  }
  if (after.global !== before.global) {
    kept.delete(after.global);
    kept.add(after.global);
  }
  return [...kept];
}

/** Count the themes Settings kept as recent, once it closes. */
export function useRecentThemesOnClose(open: boolean): void {
  useEffect(() => {
    if (!open) return;
    const openedWith = currentPicks();
    return () => {
      for (const name of keptThemePicks(openedWith, currentPicks())) {
        void window.electronAPI.theme.addRecent(name);
      }
    };
  }, [open]);
}
