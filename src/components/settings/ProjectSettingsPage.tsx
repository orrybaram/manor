import { useRef, useCallback, useState, useMemo } from "react";
import Check from "lucide-react/dist/esm/icons/check";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import Plus from "lucide-react/dist/esm/icons/plus";
import GripVertical from "lucide-react/dist/esm/icons/grip-vertical";
import {
  useProjectStore,
  type ProjectInfo,
  type CustomCommand,
} from "../../store/project-store";
import { useListDrag } from "../../hooks/useListDrag";
import { useListKeyboardNav } from "../../hooks/useListKeyboardNav";
import { useThemeStore, type Theme } from "../../store/theme-store";
import { useMountEffect } from "../../hooks/useMountEffect";
import { LinearProjectSection } from "./LinearProjectSection";
import { ProjectHostSection } from "./ProjectHostSection/ProjectHostSection";
import { HostLabel, ProjectLinksSection } from "./ProjectLinksSection";
import { DEFAULT_AGENT_COMMAND } from "../../agent-defaults";
import { PROJECT_COLORS } from "../../project-colors";
import { Input, Textarea } from "../ui/Input";
import { EmojiInput } from "../ui/EmojiAutocomplete";
import { Switch } from "../ui/Switch/Switch";
import { Button } from "../ui/Button/Button";
import { Stack, Row } from "../ui/Layout/Layout";
import { SectionTitle } from "./SectionTitle";
import styles from "./SettingsModal/SettingsModal.module.css";

const worktreeScriptFields: Array<{
  field: "worktreeStartScript" | "worktreeTeardownScript";
  label: string;
  placeholder: string;
}> = [
  {
    field: "worktreeStartScript",
    label: "Start Script",
    placeholder: "Runs in the terminal when a new worktree is created",
  },
  {
    field: "worktreeTeardownScript",
    label: "Teardown Script",
    placeholder: "Runs before a worktree is deleted",
  },
];

type ThemeColors = Pick<
  Theme,
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan"
  | "background"
  | "foreground"
>;

interface ThemeEntry {
  name: string;
  displayName: string;
  badge?: string;
}

type ProjectThemeSelectorProps = {
  project: ProjectInfo;
  /**
   * Whether a pick restyles the window now. Only for the project the page
   * is open for: on a linked group's page, another member's theme is saved
   * but not applied (ADR-192).
   */
  applyNow?: boolean;
};

function ProjectThemeSelector(props: ProjectThemeSelectorProps) {
  const { project, applyNow = true } = props;

  const updateProject = useProjectStore((s) => s.updateProject);
  const applyProjectTheme = useThemeStore((s) => s.applyProjectTheme);
  const [hasGhostty, setHasGhostty] = useState(false);
  const [query, setQuery] = useState("");
  const [allColors, setAllColors] = useState<Record<string, ThemeColors>>({});
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  useMountEffect(() => {
    setQuery("");
    Promise.all([
      window.electronAPI.theme.hasGhosttyConfig(),
      window.electronAPI.theme.allColors(),
    ]).then(([ghostty, colors]) => {
      setHasGhostty(ghostty);
      setAllColors(colors);
    });
  });

  const entries: ThemeEntry[] = useMemo(() => {
    const result: ThemeEntry[] = [];
    result.push({
      name: "__global__",
      displayName: "Global theme",
      badge: "Default",
    });
    if (hasGhostty) {
      result.push({
        name: "__ghostty__",
        displayName: "Match Ghostty",
        badge: "Ghostty",
      });
    }
    result.push({
      name: "__default__",
      displayName: "Catppuccin Mocha",
      badge: "Built-in",
    });
    for (const n of Object.keys(allColors).sort()) {
      result.push({ name: n, displayName: n });
    }
    return result;
  }, [allColors, hasGhostty]);

  const filtered = useMemo(() => {
    if (!query) return entries;
    const q = query.toLowerCase();
    return entries.filter((e) => e.displayName.toLowerCase().includes(q));
  }, [query, entries]);

  const selectedName = project.themeName ?? "__global__";

  const handleSelect = useCallback(
    (name: string) => {
      const themeValue = name === "__global__" ? null : name;
      updateProject(project.id, { themeName: themeValue });
      if (applyNow) applyProjectTheme(themeValue);
    },
    [project.id, updateProject, applyProjectTheme, applyNow],
  );

  const handleSelectByIndex = useCallback(
    (index: number) => {
      if (filtered[index]) handleSelect(filtered[index].name);
    },
    [filtered, handleSelect],
  );

  const scrollToHighlight = useCallback(
    (updater: (i: number) => number) => {
      setHighlightIndex((prev) => {
        const next = updater(prev);
        if (next >= 0 && next < filtered.length) {
          const name = filtered[next].name;
          requestAnimationFrame(() => {
            itemRefs.current.get(name)?.scrollIntoView({ block: "nearest" });
          });
        }
        return next;
      });
    },
    [filtered],
  );

  const handleKeyDown = useListKeyboardNav(
    filtered.length,
    highlightIndex,
    scrollToHighlight,
    handleSelectByIndex,
  );

  return (
    <div onKeyDown={handleKeyDown}>
      <label className={styles.fieldLabel}>Theme</label>
      <Input
        className={styles.themeSearch}
        type="text"
        placeholder="Search themes..."
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setHighlightIndex(-1);
        }}
      />
      <div style={{ maxHeight: 300, overflowY: "auto" }}>
        <div className={styles.themeList}>
          {filtered.map((entry, idx) => {
            const isSelected = entry.name === selectedName;
            const isHighlighted = idx === highlightIndex;
            const colors = allColors[entry.name] ?? null;
            const dotColors = colors
              ? [
                  colors.red,
                  colors.green,
                  colors.yellow,
                  colors.blue,
                  colors.magenta,
                  colors.cyan,
                ]
              : null;
            return (
              <div
                key={entry.name}
                ref={(el) => {
                  if (el) itemRefs.current.set(entry.name, el);
                  else itemRefs.current.delete(entry.name);
                }}
                className={`${styles.themeItem} ${isSelected ? styles.themeItemSelected : ""} ${isHighlighted ? styles.themeItemHighlighted : ""}`}
                onClick={() => handleSelect(entry.name)}
                onMouseEnter={() => setHighlightIndex(idx)}
              >
                <span className={styles.checkmark}>
                  {isSelected ? <Check size={14} /> : ""}
                </span>
                <span className={styles.themeItemLabel}>
                  {entry.displayName}
                </span>
                {entry.badge && (
                  <span className={styles.themeItemBadge}>{entry.badge}</span>
                )}
                {dotColors && (
                  <Row gap="xs" className={styles.themePreview}>
                    {dotColors.map((c, i) => (
                      <div
                        key={i}
                        className={styles.colorDot}
                        style={{ background: c }}
                      />
                    ))}
                  </Row>
                )}
              </div>
            );
          })}
          {filtered.length === 0 && (
            <div
              style={{
                padding: 16,
                textAlign: "center",
                color: "var(--text-dim)",
                fontSize: 13,
              }}
            >
              No matching themes
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Mirrors PortlessManager.hostnameForPort's slug rules — display only. */
function previewHostname(projectName: string): string {
  const slug = projectName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
  return `${slug}.localhost`;
}

function defaultWorktreePath(projectName: string): string {
  const slug = projectName
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `~/.manor/worktrees/${slug}`;
}

/**
 * A section's search anchor on this page. A linked group's page shows the
 * per-host sections once per member; the member the page was opened for
 * keeps the plain ids search jumps to, the others get their own.
 */
type SectionAnchor = (id: string) => string;

const plainAnchor: SectionAnchor = (id) => id;

type ProjectFieldProps = {
  project: ProjectInfo;
};

function NameField(props: ProjectFieldProps) {
  const { project } = props;

  const updateProject = useProjectStore((s) => s.updateProject);

  return (
    <>
      <label className={styles.fieldLabel}>Name</label>
      <EmojiInput
        defaultValue={project.name}
        onBlur={(e) => {
          const trimmed = e.target.value.trim();
          if (trimmed && trimmed !== project.name) {
            updateProject(project.id, { name: trimmed });
          }
        }}
      />
    </>
  );
}

function PathFields(props: ProjectFieldProps) {
  const { project } = props;

  return (
    <>
      <label className={styles.fieldLabel}>Path</label>
      <div className={styles.fieldStatic}>{project.path}</div>
      <label className={styles.fieldLabel}>Default Branch</label>
      <div className={styles.fieldStatic}>{project.defaultBranch}</div>
    </>
  );
}

function ColorField(props: ProjectFieldProps) {
  const { project } = props;

  const updateProject = useProjectStore((s) => s.updateProject);

  return (
    <>
      <label className={styles.fieldLabel}>Color</label>
      <Row gap="xxs" className={styles.colorPicker}>
        {PROJECT_COLORS.map((c) => {
          const isSelected = (project.color ?? null) === c.value;
          return (
            <button
              key={c.value ?? "default"}
              className={`${styles.colorOption} ${isSelected ? styles.colorOptionSelected : ""}`}
              style={{ background: `var(${c.cssVar})` }}
              title={c.label}
              onClick={() => updateProject(project.id, { color: c.value })}
            >
              {isSelected && (
                <Check size={10} strokeWidth={3} color="var(--bg)" />
              )}
            </button>
          );
        })}
      </Row>
    </>
  );
}

function AgentSection(props: ProjectFieldProps) {
  const { project } = props;

  const updateProject = useProjectStore((s) => s.updateProject);

  return (
    <Stack gap="xs">
      <SectionTitle id="project-agent">Agent</SectionTitle>
      <label className={styles.fieldLabel}>Agent Command</label>
      <Input
        defaultValue={project.agentCommand ?? ""}
        onBlur={(e) => {
          const normalized = e.target.value.trim() || null;
          if (normalized !== (project.agentCommand ?? null)) {
            updateProject(project.id, { agentCommand: normalized });
          }
        }}
        placeholder={DEFAULT_AGENT_COMMAND}
      />
    </Stack>
  );
}

type HostSectionProps = ProjectFieldProps & {
  anchor: SectionAnchor;
};

function PortsSection(props: HostSectionProps) {
  const { project, anchor } = props;

  const updateProject = useProjectStore((s) => s.updateProject);

  return (
    <Stack gap="xs">
      <SectionTitle id={anchor("project-ports")}>Ports</SectionTitle>
      <label className={styles.notifRow}>
        <span>Named preview URLs</span>
        <Switch
          checked={project.portlessEnabled !== false}
          onCheckedChange={(checked) =>
            updateProject(project.id, { portlessEnabled: checked })
          }
        />
      </label>
      <div className={styles.fieldHint}>
        Route this project's dev servers through the portless proxy so each
        workspace gets a stable hostname like{" "}
        <code>{previewHostname(project.name)}</code>. When off, ports open as{" "}
        <code>localhost:&lt;port&gt;</code>.
      </div>
    </Stack>
  );
}

function CommandsSection(props: HostSectionProps) {
  const { project, anchor } = props;

  const updateProject = useProjectStore((s) => s.updateProject);
  const [newCommandId, setNewCommandId] = useState<string | null>(null);

  const commands = useMemo(() => project.commands ?? [], [project.commands]);
  const commandIds = useMemo(() => commands.map((c) => c.id), [commands]);

  const handleReorderCommands = useCallback(
    (orderedIds: string[]) => {
      const byId = new Map(commands.map((c) => [c.id, c]));
      const reordered = orderedIds
        .map((id) => byId.get(id))
        .filter((c): c is CustomCommand => c !== undefined);
      updateProject(project.id, { commands: reordered });
    },
    [commands, project.id, updateProject],
  );

  const { handleDragStart, getTransformStyle, itemRefs } = useListDrag({
    ids: commandIds,
    onReorder: handleReorderCommands,
    gap: 6,
  });

  return (
    <Stack gap="xs">
      <SectionTitle id={anchor("project-commands")}>Commands</SectionTitle>
      <div className={styles.commandList}>
        {commands.map((cmd: CustomCommand, idx: number) => (
          <div
            key={cmd.id}
            ref={(el) => {
              if (el) itemRefs.current.set(idx, el);
              else itemRefs.current.delete(idx);
            }}
            className={styles.commandRow}
            style={getTransformStyle(idx)}
          >
            <div
              className={styles.commandDragHandle}
              title="Drag to reorder"
              onPointerDown={(e) => handleDragStart(idx, e)}
            >
              <GripVertical size={14} />
            </div>
            <Input
              ref={(el) => {
                if (el && cmd.id === newCommandId) {
                  el.focus();
                  setNewCommandId(null);
                }
              }}
              className={styles.commandNameInput}
              defaultValue={cmd.name}
              placeholder="Name"
              onBlur={(e) => {
                const updatedCommands = (project.commands ?? []).map((c) =>
                  c.id === cmd.id ? { ...c, name: e.target.value } : c,
                );
                updateProject(project.id, { commands: updatedCommands });
              }}
            />
            <Input
              className={styles.commandCmdInput}
              defaultValue={cmd.command}
              placeholder="Command"
              onBlur={(e) => {
                const updatedCommands = (project.commands ?? []).map((c) =>
                  c.id === cmd.id ? { ...c, command: e.target.value } : c,
                );
                updateProject(project.id, { commands: updatedCommands });
              }}
            />
            <button
              className={styles.commandDeleteBtn}
              aria-label="Delete command"
              onClick={() => {
                const filtered = (project.commands ?? []).filter(
                  (c) => c.id !== cmd.id,
                );
                updateProject(project.id, { commands: filtered });
              }}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        <button
          className={styles.addCommandBtn}
          onClick={() => {
            const id = crypto.randomUUID();
            const newCommand: CustomCommand = {
              id,
              name: "",
              command: "",
            };
            updateProject(project.id, {
              commands: [...(project.commands ?? []), newCommand],
            });
            setNewCommandId(id);
          }}
        >
          <Plus size={12} />
          Add Command
        </button>
      </div>
    </Stack>
  );
}

function WorktreesSection(props: HostSectionProps) {
  const { project, anchor } = props;

  const updateProject = useProjectStore((s) => s.updateProject);

  const saveField = (
    field: "worktreePath" | "worktreeStartScript" | "worktreeTeardownScript",
    value: string,
  ) => {
    const normalized = value.trim() || null;
    if (normalized !== (project[field] ?? null)) {
      updateProject(project.id, { [field]: normalized });
    }
  };

  return (
    <Stack gap="xl">
      <SectionTitle id={anchor("project-worktrees")}>Worktrees</SectionTitle>
      <Stack gap="xs">
        <label className={styles.fieldLabel}>Worktree Path</label>
        <Input
          defaultValue={project.worktreePath ?? ""}
          onBlur={(e) => saveField("worktreePath", e.target.value)}
          placeholder={defaultWorktreePath(project.name)}
        />
        <div className={styles.fieldHint}>
          Directory where new worktrees are created. Defaults to{" "}
          {defaultWorktreePath(project.name)}
        </div>
      </Stack>
      {worktreeScriptFields.map(({ field, label, placeholder }) => (
        <Stack key={field} gap="xs">
          <label className={styles.fieldLabel}>{label}</label>
          <Textarea
            monospace
            defaultValue={project[field] ?? ""}
            onBlur={(e) => saveField(field, e.target.value)}
            placeholder={placeholder}
            rows={4}
          />
        </Stack>
      ))}
    </Stack>
  );
}

type MemberSettingsProps = ProjectFieldProps & {
  /** Whether this is the member the page was opened for. */
  isPageProject: boolean;
};

/**
 * One member's per-host settings on a linked group's page (ADR-192): what
 * differs between machines — path, theme, host, ports, commands, worktrees.
 */
function MemberSettings(props: MemberSettingsProps) {
  const { project, isPageProject } = props;

  const anchor: SectionAnchor = isPageProject
    ? plainAnchor
    : (id) => `${id}-${project.id}`;

  const unlinkProject = useProjectStore((s) => s.unlinkProject);

  return (
    <Stack className={styles.hostSettings}>
      <Stack gap="xs">
        <Row gap="sm" align="center" justify="space-between">
          <Row gap="xs" align="center" className={styles.hostSettingsHeading}>
            <HostLabel hostId={project.hostId} />
          </Row>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void unlinkProject(project.id)}
          >
            Unlink
          </Button>
        </Row>
        <PathFields project={project} />
        <ProjectThemeSelector project={project} applyNow={isPageProject} />
      </Stack>
      <ProjectHostSection project={project} sectionId={anchor("project-host")} />
      <PortsSection project={project} anchor={anchor} />
      <CommandsSection project={project} anchor={anchor} />
      <WorktreesSection project={project} anchor={anchor} />
    </Stack>
  );
}

type ProjectSettingsPageProps = {
  project: ProjectInfo;
};

export function ProjectSettingsPage(props: ProjectSettingsPageProps) {
  const { project } = props;

  const projects = useProjectStore((s) => s.projects);
  const memberIds = project.group?.memberIds;
  const members = useMemo(() => {
    if (!memberIds) return [];
    const byId = new Map(projects.map((p) => [p.id, p]));
    return memberIds
      .map((id) => byId.get(id))
      .filter((p): p is ProjectInfo => p !== undefined);
  }, [memberIds, projects]);

  if (project.group) {
    // The name field is keyed by the group's name, so a rename made
    // elsewhere (the CLI, say) shows here instead of the stale value.
    return (
      <Stack className={styles.pageContent}>
        <Stack gap="xs">
          <SectionTitle id="project-general">Shared</SectionTitle>
          <div className={styles.sectionDescription}>
            Shared by every host in this group. Each host's own settings
            follow below.
          </div>
          <NameField key={project.name} project={project} />
          <ColorField project={project} />
        </Stack>
        <LinearProjectSection project={project} />
        <AgentSection project={project} />
        <ProjectLinksSection project={project} members={members} />
        {members.map((member) => (
          <MemberSettings
            key={member.id}
            project={member}
            isPageProject={member.id === project.id}
          />
        ))}
      </Stack>
    );
  }

  return (
    <Stack className={styles.pageContent}>
      <Stack gap="xs">
        <SectionTitle id="project-general">General</SectionTitle>
        <NameField project={project} />
        <PathFields project={project} />
        <ColorField project={project} />
        <ProjectThemeSelector project={project} />
      </Stack>
      <LinearProjectSection project={project} />
      <ProjectHostSection project={project} />
      <AgentSection project={project} />
      <PortsSection project={project} anchor={plainAnchor} />
      <CommandsSection project={project} anchor={plainAnchor} />
      <WorktreesSection project={project} anchor={plainAnchor} />
      <ProjectLinksSection project={project} members={members} />
    </Stack>
  );
}
