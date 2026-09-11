/** Search index for the settings modal: every page and section, in nav order. */

export type SettingsPageId =
  | "general"
  | "app"
  | "keybindings"
  | "notifications"
  | "integrations"
  | "home"
  | "remote";

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

type SectionEntry = SettingsSection & {
  pageLabel: string;
  page:
    | { type: SettingsPageId }
    | { type: "project"; projectId: string };
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
        label: "Diff",
        keywords: ["diff", "panel", "side by side", "changes"],
      },
      {
        id: "general-stats",
        label: "Usage Stats",
        keywords: ["stats", "usage", "telemetry", "reset", "privacy"],
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
        keywords: ["linear", "issues", "tickets", "api key"],
      },
    ],
  },
  {
    page: "home",
    pageLabel: "Home",
    pageKeywords: ["home", "local", "workspace", "harness"],
    sections: [
      {
        id: "home-harness",
        label: "Harness",
        keywords: ["harness", "claude", "codex", "custom", "interrupt", "home"],
      },
    ],
  },
  {
    page: "remote",
    pageLabel: "Remote control",
    pageKeywords: ["remote", "remote control", "devices", "phone", "tunnel", "mobile"],
    sections: [
      {
        id: "remote-devices",
        label: "Devices",
        keywords: ["device", "pairing", "token", "qr", "phone", "revoke"],
      },
      {
        id: "remote-tunnel",
        label: "Tunnel",
        keywords: ["tunnel", "expose", "ngrok", "cloudflare", "url", "remote"],
      },
    ],
  },
];

const PROJECT_SECTIONS: SettingsSection[] = [
  {
    id: "project-general",
    label: "General",
    keywords: ["name", "path", "repository", "color", "theme"],
  },
  {
    id: "project-linear",
    label: "Linear",
    keywords: ["linear", "team", "issues"],
  },
  {
    id: "project-agent",
    label: "Agent",
    keywords: ["agent", "command", "claude", "codex"],
  },
  {
    id: "project-ports",
    label: "Ports",
    keywords: ["port", "portless", "preview", "proxy", "hostname", "url"],
  },
  {
    id: "project-commands",
    label: "Commands",
    keywords: ["command", "custom", "script", "run"],
  },
  {
    id: "project-worktrees",
    label: "Worktrees",
    keywords: ["worktree", "branch", "path", "setup", "git"],
  },
];

/**
 * Every searchable entry, including one set per project. Each page leads its own
 * sections, so a page and its sections tie-break in nav order.
 */
export function buildSettingsIndex(
  projects: { id: string; name: string }[],
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

  const perProject = projects.flatMap((project) => [
    {
      id: null,
      label: project.name,
      keywords: ["project", "repository", "repo"],
      pageLabel: project.name,
      page: { type: "project", projectId: project.id } as const,
    },
    ...PROJECT_SECTIONS.map((section) => ({
      ...section,
      pageLabel: project.name,
      page: { type: "project", projectId: project.id } as const,
    })),
  ]);

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
