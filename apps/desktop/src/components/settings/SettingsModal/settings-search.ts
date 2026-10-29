/** Search index for the settings modal: every page and section, in nav order. */

export type SettingsPageId =
  | "general"
  | "app"
  | "keybindings"
  | "notifications"
  | "integrations"
  | "hosts"
  | "devices"
  | "automations";

export type SettingsSection = {
  /**
   * Matches the `data-settings-section` attribute on the section heading.
   * `null` for a whole page, which opens at the top instead of scrolling.
   */
  id: string | null;
  label: string;
  /** Extra terms that should surface this section, beyond its label. */
  keywords: string[];
};

/**
 * A page of the settings modal: a fixed page, a lone project's page, or a
 * group's page, which is a project set up on several hosts. Both project
 * kinds render the same page.
 */
export type SettingsPage =
  | { type: SettingsPageId }
  | { type: "project"; projectId: string }
  | { type: "group"; groupId: string };

type SectionEntry = SettingsSection & {
  pageLabel: string;
  page: SettingsPage;
};

export type SettingsSearchResult = SectionEntry;

const PAGE_SECTIONS: {
  page: SettingsPageId;
  pageLabel: string;
  /** Extra terms that should surface the page itself, beyond its label. */
  pageKeywords: string[];
  sections: SettingsSection[];
}[] = [
  {
    page: "general",
    pageLabel: "General",
    pageKeywords: ["general", "settings", "preferences", "options"],
    sections: [
      {
        id: "general-editor",
        label: "Code Editor",
        keywords: ["editor", "code", "cursor", "zed", "vim", "nvim", "terminal"],
      },
      {
        id: "general-diff",
        label: "Source Control",
        keywords: ["source control", "scm", "git", "diff", "panel", "side by side", "changes"],
      },
      {
        id: "general-stats",
        label: "Usage Stats",
        keywords: ["stats", "usage", "telemetry", "reset", "privacy"],
      },
      {
        id: "general-folder-suggestions",
        label: "Folder Suggestions",
        keywords: ["folder", "suggest", "jev", "typesafe", "workspace", "privacy"],
      },
    ],
  },
  {
    page: "app",
    pageLabel: "Appearance",
    pageKeywords: ["appearance", "look", "theme", "style", "font", "colors"],
    sections: [
      {
        id: "app-theme",
        label: "Theme",
        keywords: ["theme", "dark", "light", "colors", "accent", "appearance"],
      },
      {
        id: "app-font",
        label: "Font",
        keywords: ["font", "family", "size", "typeface"],
      },
      {
        id: "app-seasonal",
        label: "Seasonal",
        keywords: ["halloween", "cobwebs", "dust", "seasonal", "spooky"],
      },
    ],
  },
  {
    page: "keybindings",
    pageLabel: "Keybindings",
    pageKeywords: ["keybindings", "shortcuts", "hotkeys", "keyboard"],
    sections: [
      {
        id: "keybindings-list",
        label: "Keybindings",
        keywords: ["shortcut", "shortcuts", "hotkey", "keys", "keyboard"],
      },
    ],
  },
  {
    page: "notifications",
    pageLabel: "Notifications",
    pageKeywords: ["notifications", "alerts", "notify", "sounds"],
    sections: [
      {
        id: "notifications-triggers",
        label: "Notify me when...",
        keywords: ["notification", "alert", "agent", "responds", "needs input"],
      },
      {
        id: "notifications-pr",
        label: "Pull requests",
        keywords: ["pr", "pull request", "comment", "review", "approved"],
      },
    ],
  },
  {
    page: "integrations",
    pageLabel: "Integrations",
    pageKeywords: ["integrations", "connections", "github", "linear", "accounts"],
    sections: [
      {
        id: "integrations-github",
        label: "GitHub",
        keywords: ["github", "gh", "token", "auth", "sign in"],
      },
      {
        id: "integrations-linear",
        label: "Linear",
        keywords: ["linear", "issues", "tasks", "tickets", "api key"],
      },
    ],
  },
  {
    page: "hosts",
    pageLabel: "Hosts",
    pageKeywords: ["hosts", "remote", "ssh", "server", "machine", "vm", "container", "pod", "docker", "kubernetes"],
    sections: [
      {
        id: "hosts-list",
        label: "Hosts",
        keywords: ["wake", "stop", "asleep", "remove", "destroy", "restart", "supervise", "systemd", "launchd"],
      },
      {
        id: "host-local",
        label: "This Mac",
        keywords: ["relay", "remote control", "expose", "url", "remote", "address", "devices", "pairing keys", "reset"],
      },
      {
        id: "hosts-add",
        label: "Add a host",
        keywords: ["add", "ssh", "start", "recipe", "template", "docker", "kubernetes", "new host"],
      },
    ],
  },
  {
    page: "devices",
    pageLabel: "Devices",
    pageKeywords: ["devices", "remote", "remote control", "phone", "relay", "mobile"],
    sections: [
      {
        id: "remote-devices",
        label: "Paired devices",
        keywords: ["device", "pairing", "token", "qr", "phone", "revoke"],
      },
      {
        id: "devices-hosts",
        label: "Hosts your devices can reach",
        keywords: ["reach", "hosts", "allow", "phone"],
      },
    ],
  },
  {
    page: "automations",
    pageLabel: "Automations",
    pageKeywords: ["automations", "schedule", "scheduled agents", "cron", "recurring", "timer", "routine"],
    sections: [
      {
        id: "automations-list",
        label: "Automations",
        keywords: ["schedule", "cron", "scheduled agents", "run now", "pause", "every day", "weekdays", "hourly"],
      },
    ],
  },
];

const PROJECT_SECTIONS: SettingsSection[] = [
  {
    id: "project-general",
    label: "General",
    keywords: ["name", "color", "theme"],
  },
  {
    id: "project-linear",
    label: "Linear",
    keywords: ["linear", "team", "issues", "tasks"],
  },
  {
    id: "project-host",
    label: "Hosts",
    keywords: [
      "host",
      "hosts",
      "remote",
      "ssh",
      "machine",
      "server",
      "set up on",
      "remove from",
      "keep separate",
      "worktree",
      "branch",
      "path",
      "folder",
      "port",
      "portless",
      "preview",
      "proxy",
      "hostname",
      "url",
    ],
  },
  {
    id: "project-agent",
    label: "Agent",
    keywords: ["agent", "command", "claude", "codex"],
  },
  {
    id: "project-commands",
    label: "Commands",
    keywords: ["command", "custom", "script", "run"],
  },
];

/**
 * The Projects part of the nav, in sidebar order: one row per project, a
 * project set up on several hosts listed once where its first host's copy
 * would be.
 */
export type SettingsProjectEntry = {
  kind: "project" | "group";
  id: string;
  name: string;
};

/**
 * The section a project deep link scrolls to. A member's
 * host link lands on that member's row of the Hosts section, so the row
 * opens; everything else names the section itself.
 */
export function projectJumpId(
  section: string | null | undefined,
  projectId: string,
  grouped: boolean,
): string | null {
  if (!section) return null;
  if (section === "project-host" && grouped) return `project-host-${projectId}`;
  return section;
}

/**
 * Every searchable entry, including one set per project. Each page leads
 * its own sections, so a page and its sections tie-break in nav order.
 */
export function buildSettingsIndex(
  projects: readonly SettingsProjectEntry[],
): SectionEntry[] {
  const fixed = PAGE_SECTIONS.flatMap(
    ({ page, pageLabel, pageKeywords, sections }) => [
      {
        id: null,
        label: pageLabel,
        keywords: pageKeywords,
        pageLabel,
        page: { type: page } as const,
      },
      // A lone section named after its page would just repeat the page entry.
      ...sections
        .filter((section) => section.label !== pageLabel)
        .map((section) => ({
          ...section,
          pageLabel,
          page: { type: page } as const,
        })),
    ],
  );

  const pageEntries = (
    label: string,
    page: SettingsPage,
    sections: SettingsSection[],
  ): SectionEntry[] => [
    {
      id: null,
      label,
      keywords: ["project", "repository", "repo"],
      pageLabel: label,
      page,
    },
    ...sections.map((section) => ({ ...section, pageLabel: label, page })),
  ];

  const perProject = projects.flatMap((entry) =>
    pageEntries(
      entry.name,
      entry.kind === "group"
        ? { type: "group", groupId: entry.id }
        : { type: "project", projectId: entry.id },
      PROJECT_SECTIONS,
    ),
  );

  return [...fixed, ...perProject];
}

/** Rank: label prefix beats label substring beats page name beats keyword. */
function score(entry: SectionEntry, query: string): number {
  const label = entry.label.toLowerCase();
  const pageLabel = entry.pageLabel.toLowerCase();

  if (label.startsWith(query)) return 0;
  if (label.includes(query)) return 1;
  if (pageLabel.startsWith(query)) return 2;
  if (pageLabel.includes(query)) return 3;
  if (entry.keywords.some((k) => k.startsWith(query))) return 4;
  if (entry.keywords.some((k) => k.includes(query))) return 5;
  return -1;
}

export function searchSettings(
  index: SectionEntry[],
  rawQuery: string,
): SettingsSearchResult[] {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return [];

  return index
    .map((entry, order) => ({ entry, order, rank: score(entry, query) }))
    .filter((row) => row.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .map((row) => row.entry);
}
