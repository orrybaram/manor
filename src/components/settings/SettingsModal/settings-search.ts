/** Search index for the settings modal: every page and section, in nav order. */

export type SettingsPageId =
  | "general"
  | "app"
  | "keybindings"
  | "notifications"
  | "integrations"
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

/**
 * A page of the settings modal: a fixed page, a project's (a lone project's
 * whole page, or a linked member's machine-specific page), or a linked
 * group's shared page (ADR-193).
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
        keywords: ["linear", "issues", "tasks", "tickets", "api key"],
      },
    ],
  },
  {
    page: "remote",
    pageLabel: "Remote control",
    pageKeywords: ["remote", "remote control", "devices", "phone", "relay", "mobile"],
    sections: [
      {
        id: "remote-devices",
        label: "Devices",
        keywords: ["device", "pairing", "token", "qr", "phone", "revoke"],
      },
      {
        id: "remote-relay",
        label: "Relay",
        keywords: ["relay", "expose", "url", "remote", "address"],
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
    keywords: ["linear", "team", "issues", "tasks"],
  },
  {
    id: "project-host",
    label: "Host",
    keywords: ["host", "remote", "ssh", "machine", "server"],
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
  {
    id: "project-links",
    label: "Linked projects",
    keywords: ["link", "unlink", "group", "host", "remote"],
  },
];

/**
 * The section ids that are per machine on a linked group (ADR-193): they
 * live on each member's page, every other project section on the group's.
 */
export const MACHINE_SECTION_IDS: readonly string[] = [
  "project-location",
  "project-host",
  "project-worktrees",
  "project-ports",
];

const sectionById = new Map(PROJECT_SECTIONS.map((s) => [s.id, s]));
const projectSection = (id: string): SettingsSection => sectionById.get(id)!;

/** A linked group's shared page. */
const GROUP_SECTIONS: SettingsSection[] = [
  {
    id: "project-general",
    label: "Shared",
    keywords: ["name", "color", "theme", "shared"],
  },
  ...["project-linear", "project-agent", "project-commands", "project-links"].map(
    projectSection,
  ),
];

/** A linked member's machine-specific page. */
const MEMBER_SECTIONS: SettingsSection[] = [
  {
    id: "project-location",
    label: "Location",
    keywords: ["path", "folder", "directory", "branch", "unlink"],
  },
  ...["project-host", "project-worktrees", "project-ports"].map(projectSection),
];

/**
 * The Projects part of the nav, in sidebar order: a lone project, or a
 * linked group listed once where its first member would be, with its
 * members (in `memberIds` order) nested under it.
 */
export type SettingsProjectEntry =
  | { kind: "project"; id: string; name: string }
  | {
      kind: "group";
      id: string;
      name: string;
      members: { id: string; hostId: string; hostLabel: string }[];
    };

/**
 * Every searchable entry, including one set per project, group and group
 * member. Each page leads its own sections, so a page and its sections
 * tie-break in nav order.
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

  const perProject = projects.flatMap((entry) => {
    if (entry.kind === "project") {
      return pageEntries(
        entry.name,
        { type: "project", projectId: entry.id },
        PROJECT_SECTIONS,
      );
    }
    return [
      ...pageEntries(entry.name, { type: "group", groupId: entry.id }, GROUP_SECTIONS),
      ...entry.members.flatMap((member) =>
        pageEntries(
          `${entry.name} · ${member.hostLabel}`,
          { type: "project", projectId: member.id },
          MEMBER_SECTIONS,
        ),
      ),
    ];
  });

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
