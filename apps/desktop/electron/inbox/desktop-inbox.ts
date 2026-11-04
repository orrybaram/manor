import { INBOX_TYPES, type InboxKind, type InboxPreferenceKey } from "../../src/lib/inbox";
import type { GitHubManager } from "../github";
import type { LinearManager } from "../linear";
import type { ServerNotifier } from "../notifications";
import type { AppPreferences } from "../preferences";
import { createGitHubSource } from "./github-source";
import { InboxPoller } from "./inbox-poller";
import { createLinearSource } from "./linear-source";
import { ProjectScope, type ProjectScopeDeps } from "./project-scope";

const PREFERENCE_BY_KIND = new Map<InboxKind, InboxPreferenceKey>(
  INBOX_TYPES.map((t) => [t.kind, t.preference]),
);

export function createDesktopInboxPoller(opts: {
  dataDir: string;
  githubManager: GitHubManager;
  linearManager: LinearManager;
  projectManager: ProjectScopeDeps;
  preferencesManager: { get<K extends keyof AppPreferences>(key: K): AppPreferences[K] };
  notifier: ServerNotifier;
}): InboxPoller {
  const { githubManager, linearManager, preferencesManager, notifier } = opts;
  const scope = new ProjectScope(opts.projectManager);
  // A sign-in holds until a check fails; otherwise `gh` is asked each check.
  let githubReady = false;
  // A test's stand-in for waiting a minute between checks.
  const intervalMs = Number(process.env.MANOR_E2E_INBOX_POLL_MS) || undefined;
  return new InboxPoller({
    dataDir: opts.dataDir,
    ...(intervalMs ? { intervalMs } : {}),
    sources: [
      createGitHubSource({
        isReady: async () => {
          if (githubReady) return true;
          githubReady = await githubManager.isSignedIn();
          return githubReady;
        },
        account: () => githubManager.getLogin(),
        fetchInbox: (since, ifModifiedSince) =>
          githubManager.getInbox(since, ifModifiedSince).catch((err: unknown) => {
            githubReady = false;
            throw err;
          }),
        projectRepos: () => scope.repos(),
      }),
      createLinearSource({
        isConnected: () => linearManager.isConnected(),
        fetchNotifications: (since) => linearManager.getNotifications(since),
        projectTeams: () => scope.teams(),
      }),
    ],
    isEnabled: (kind) => {
      const key = PREFERENCE_BY_KIND.get(kind);
      return key ? preferencesManager.get(key) : false;
    },
    deliver: (item, { banner }) => notifier.showInboxNotification?.(item, { banner }),
    log: (message) => console.warn(`[inbox] ${message}`),
  });
}
