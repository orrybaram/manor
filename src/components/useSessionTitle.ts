import { useAppStore, selectActiveWorkspace } from "../store/app-store";

export function useSessionTitle(sessionId: string): string {
  const focusedPaneId = useAppStore((s) => {
    const ws = selectActiveWorkspace(s);
    const session = ws?.sessions.find((t) => t.id === sessionId);
    return session?.focusedPaneId ?? null;
  });

  const title = useAppStore((s) => focusedPaneId ? s.paneTitle[focusedPaneId] ?? null : null);
  const cwd = useAppStore((s) => focusedPaneId ? s.paneCwd[focusedPaneId] ?? null : null);
  if (title) {
    const cwdMatch = title.match(/^.+@.+:(.+)$/);
    if (cwdMatch) {
      const path = cwdMatch[1];
      const parts = path.replace(/\/+$/, "").split("/");
      return parts[parts.length - 1] || title;
    }
    return title;
  }

  // Fall back to CWD of the focused pane
  if (cwd) {
    const parts = cwd.split("/");
    return parts[parts.length - 1] || parts[parts.length - 2] || cwd;
  }

  return "Terminal";
}
