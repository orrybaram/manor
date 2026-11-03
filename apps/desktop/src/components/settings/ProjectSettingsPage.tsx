import { useCallback, useState, useMemo } from "react";
import { toast } from "../../toast";
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
import { useThemeStore } from "../../store/theme-store";
import type { ThemeListEntry } from "../../../electron/theme";
import { useMountEffect } from "../../hooks/useMountEffect";
import { LinearProjectSection } from "./LinearProjectSection";
import { ProjectHostsSection } from "./ProjectHostsSection/ProjectHostsSection";
import { DEFAULT_AGENT_COMMAND } from "../../agent-defaults";
import { PROJECT_COLORS } from "../../project-colors";
import { Input } from "../ui/Input";
import { EmojiInput } from "../ui/EmojiAutocomplete";
import { SearchableSelect } from "../ui/SearchableSelect/SearchableSelect";
import { Stack, Row } from "../ui/Layout/Layout";
import { SectionTitle } from "./SectionTitle";
import styles from "./SettingsModal/SettingsModal.module.css";

type ProjectThemeSelectorProps = {
  /** The project, or on a group's page its lead member (the theme is shared). */
  project: ProjectInfo;
};

function ProjectThemeSelector(props: ProjectThemeSelectorProps) {
  const { project } = props;

  const updateProject = useProjectStore((s) => s.updateProject);
  const applyProjectTheme = useThemeStore((s) => s.applyProjectTheme);
  const [themes, setThemes] = useState<ThemeListEntry[]>([]);

  useMountEffect(() => {
    window.electronAPI.theme.catalog().then(
      (catalog) => setThemes(catalog.themes),
      (err: unknown) => {
        // Not an empty list: say the themes couldn't be read.
        toast.error("Couldn't load themes", { id: "project-theme-list", error: err });
      },
    );
  });

  const selectedName = project.themeName ?? "__global__";

  const handleSelect = useCallback(
    (name: string) => {
      const themeValue = name === "__global__" ? null : name;
      updateProject(project.id, { themeName: themeValue });
      applyProjectTheme(themeValue);
    },
    [project.id, updateProject, applyProjectTheme],
  );

  const options = useMemo(() => {
    const badge = (text: string) => (
      <span className={styles.themeItemBadge}>{text}</span>
    );
    return [
      { value: "__global__", label: "Global theme", trailing: badge("Default") },
      ...themes.map((entry) => {
        const { colors } = entry;
        // "Default" here is the global theme, so the built-in Catppuccin
        // reads as what it is.
        const label =
          entry.source === "custom"
            ? "Yours"
            : entry.name === "__default__"
              ? "Built-in"
              : entry.badge;
        return {
          value: entry.name,
          label: entry.displayName,
          trailing: (
            <>
              {label && badge(label)}
              <Row gap="xs" className={styles.themePreview}>
                {[
                  colors.red,
                  colors.green,
                  colors.yellow,
                  colors.blue,
                  colors.magenta,
                  colors.cyan,
                ].map((c, k) => (
                  <div
                    key={k}
                    className={styles.colorDot}
                    style={{ background: c }}
                  />
                ))}
              </Row>
            </>
          ),
        };
      }),
    ];
  }, [themes]);

  return (
    <Stack gap="xs">
      <label className={styles.fieldLabel} htmlFor="project-theme">
        Theme
      </label>
      <SearchableSelect
        id="project-theme"
        value={selectedName}
        onChange={handleSelect}
        options={options}
        listMaxHeight={320}
        className={styles.fullWidthSelect}
        data-testid="project-theme-select"
      />
    </Stack>
  );
}

type ProjectFieldProps = {
  project: ProjectInfo;
};

function NameField(props: ProjectFieldProps) {
  const { project } = props;

  const updateProject = useProjectStore((s) => s.updateProject);

  return (
    <Stack gap="xs">
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
    </Stack>
  );
}

function ColorField(props: ProjectFieldProps) {
  const { project } = props;

  const updateProject = useProjectStore((s) => s.updateProject);

  return (
    <Stack gap="xs">
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
    </Stack>
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

function CommandsSection(props: ProjectFieldProps) {
  const { project } = props;

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
      <SectionTitle id="project-commands">Commands</SectionTitle>
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

type ProjectSettingsPageProps = {
  /** The project, or for one set up on several hosts its first member. */
  lead: ProjectInfo;
  /** Every host's copy of the project in `memberIds` order; `[lead]` when alone. */
  members: ProjectInfo[];
};

/**
 * A project's one settings page, whether it is set up on one
 * host or several. A group's members all carry the group's values for the
 * shared fields, and `updateProject` sends them to the group, so
 * the shared fields read and write through the lead member. What differs per
 * host lives in the Hosts section, one row per host.
 */
export function ProjectSettingsPage(props: ProjectSettingsPageProps) {
  const { lead, members } = props;

  // The name field is keyed by the group's name, so a rename made
  // elsewhere (the CLI, say) shows here instead of the stale value.
  return (
    <Stack className={styles.pageContent}>
      <Stack gap="xs">
        <SectionTitle id="project-general">General</SectionTitle>
        <div className={styles.generalGrid}>
          <NameField key={lead.group?.name ?? lead.name} project={lead} />
          <ProjectThemeSelector project={lead} />
        </div>
        <ColorField project={lead} />
      </Stack>
      <LinearProjectSection project={lead} />
      <ProjectHostsSection project={lead} members={members} />
      <AgentSection project={lead} />
      <CommandsSection project={lead} />
    </Stack>
  );
}
