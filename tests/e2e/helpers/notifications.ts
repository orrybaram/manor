import fs from "fs";
import path from "path";

/**
 * The desktop's notification center, read off disk: what main persisted in
 * `notifications.json` under the test's temp HOME. Shared by
 * `remote-host.spec.ts` and `lid-closed.spec.ts`, which count the
 * notifications a replayed absence raised.
 */

/** Mirrors `notificationsFile()` in electron/paths.ts. */
export function agentNotifications(tempHome: string, agentId: string): { kind: string }[] {
  const dataDir =
    process.platform === "darwin"
      ? path.join(tempHome, "Library", "Application Support", "Manor")
      : path.join(tempHome, ".local", "share", "Manor");
  const file = path.join(dataDir, "notifications.json");
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as {
      notifications?: { kind: string; target: { type: string; agentId?: string } | null }[];
    };
    return (parsed.notifications ?? []).filter(
      (n) => n.target?.type === "agent" && n.target.agentId === agentId,
    );
  } catch {
    return []; // Mid-write; the poll comes back.
  }
}
