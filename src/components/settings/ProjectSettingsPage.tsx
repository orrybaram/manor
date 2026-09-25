import { useRef, useCallback, useState, useMemo } from "react";
import Check from "lucide-react/dist/esm/icons/check";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import Plus from "lucide-react/dist/esm/icons/plus";
import GripVertical from "lucide-react/dist/esm/icons/grip-vertical";
import RotateCw from "lucide-react/dist/esm/icons/rotate-cw";
import {
  useProjectStore,
  type ProjectInfo,
  type CustomCommand,
} from "../../store/project-store";
import { useAppStore } from "../../store/app-store";
import { useHostStore, selectHost } from "../../store/host-store";
import { describeHostStatus } from "../../lib/host-status";
import { LOCAL_HOST_ID } from "../../lib/hosts";
import { useListDrag } from "../../hooks/useListDrag";
import { useListKeyboardNav } from "../../hooks/useListKeyboardNav";
import { useThemeStore, type Theme } from "../../store/theme-store";
import { useMountEffect } from "../../hooks/useMountEffect";
import { LinearProjectSection } from "./LinearProjectSection";
import { DEFAULT_AGENT_COMMAND } from "../../agent-defaults";
import { PROJECT_COLORS } from "../../project-colors";
import { Input, Textarea } from "../ui/Input";
import { Switch } from "../ui/Switch/Switch";
import { Button } from "../ui/Button/Button";
import { Tooltip } from "../ui/Tooltip/Tooltip";
import { SearchableSelect } from "../ui/SearchableSelect/SearchableSelect";
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
};

function ProjectThemeSelector(props: ProjectThemeSelectorProps) {
  const { project } = props;

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
      applyProjectTheme(themeValue);
    },
    [project.id, updateProject, applyProjectTheme],
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

const ADD_HOST_VALUE = "__add_host__";

/** Whether any workspace of `project` has an open tab in this window. */
function projectHasOpenPanes(
  project: ProjectInfo,
  workspaceLayouts: Record<string, { panels: Record<string, { tabs: unknown[] }> }>,
): boolean {
  return project.workspaces.some((ws) => {
    const layout = workspaceLayouts[ws.path];
    if (!layout) return false;
    return Object.values(layout.panels).some((panel) => panel.tabs.length > 0);
  });
}

type ProjectHostSectionProps = {
  project: ProjectInfo;
};

/**
 * The host this project's paths, git and terminals live on (ADR-160). Local
 * is the default and always available; remote hosts are whatever the user
 * has registered (across every project) plus an inline "add a new one" flow
 * so this is the only place a first remote host has to be reachable from.
 */
function ProjectHostSection(props: ProjectHostSectionProps) {
  const { project } = props;

  const updateProject = useProjectStore((s) => s.updateProject);
  const hosts = useHostStore((s) => s.hosts);
  const addHost = useHostStore((s) => s.addHost);
  const retryConnect = useHostStore((s) => s.retryConnect);
  const hostBusy = useHostStore((s) => s.busy);
  const workspaceLayouts = useAppStore((s) => s.workspaceLayouts);

  const [adding, setAdding] = useState(false);
  const [targetInput, setTargetInput] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const targetInputRef = useRef<HTMLInputElement>(null);

  const currentHostId = project.hostId ?? LOCAL_HOST_ID;
  const currentHost = useHostStore(selectHost(currentHostId));

  const options = useMemo(() => {
    const remote = hosts
      .filter((h) => h.hostId !== LOCAL_HOST_ID)
      .map((h) => ({ value: h.hostId, label: h.spec?.target ?? h.hostId }));
    return [
      { value: LOCAL_HOST_ID, label: "Local (this machine)" },
      ...remote,
      { value: ADD_HOST_VALUE, label: "Add new host…" },
    ];
  }, [hosts]);

  const applyHostChange = useCallback(
    (hostId: string) => {
      if (hostId === currentHostId) return;
      if (projectHasOpenPanes(project, workspaceLayouts)) {
        const ok = window.confirm(
          "This project has open panes. Switching its host does not move them — " +
            "existing terminals keep running where they are, and new ones will start " +
            "on the new host. Continue?",
        );
        if (!ok) return;
      }
      updateProject(project.id, { hostId });
    },
    [currentHostId, project, updateProject, workspaceLayouts],
  );

  const handleSelect = useCallback(
    (value: string) => {
      if (value === ADD_HOST_VALUE) {
        setAdding(true);
        setAddError(null);
        requestAnimationFrame(() => targetInputRef.current?.focus());
        return;
      }
      applyHostChange(value);
    },
    [applyHostChange],
  );

  const handleAddHost = useCallback(() => {
    const target = targetInput.trim();
    if (!target) return;
    setAddError(null);
    addHost(target)
      .then(({ hostId }) => {
        setAdding(false);
        setTargetInput("");
        applyHostChange(hostId);
      })
      .catch((err: unknown) => {
        setAddError(err instanceof Error ? err.message : String(err));
      });
  }, [addHost, applyHostChange, targetInput]);

  const display = currentHost ? describeHostStatus(currentHost) : null;

  return (
    <Stack gap="xs">
      <SectionTitle id="project-host">Host</SectionTitle>
      <label className={styles.fieldLabel}>Host</label>
      <SearchableSelect
        value={currentHostId}
        onChange={handleSelect}
        options={options}
        maxWidth={320}
      />
      {display && currentHostId !== LOCAL_HOST_ID && (
        <Row gap="xs" align="center">
          <span
            className={styles.fieldHint}
            style={
              display.tone === "error"
                ? { color: "var(--red)" }
                : display.tone === "warn" || display.tone === "pending"
                  ? { color: "var(--yellow)" }
                  : undefined
            }
          >
            {display.label}
            {display.detail ? ` — ${display.detail}` : ""}
          </span>
          {(display.tone === "error" || display.tone === "pending") && (
            <Tooltip label="Retry connecting">
              <Button
                variant="ghost"
                size="sm"
                aria-label="Retry connecting"
                onClick={() => retryConnect(currentHostId)}
              >
                <RotateCw size={12} />
              </Button>
            </Tooltip>
          )}
        </Row>
      )}
      {adding && (
        <Stack gap="xs">
          <Input
            ref={targetInputRef}
            placeholder="user@host or an ssh config alias"
            value={targetInput}
            disabled={hostBusy}
            onChange={(e) => setTargetInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAddHost();
              if (e.key === "Escape") setAdding(false);
            }}
          />
          <Row gap="xs">
            <Button
              variant="secondary"
              size="sm"
              disabled={hostBusy || targetInput.trim() === ""}
              onClick={handleAddHost}
            >
              Connect
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </Row>
          {addError && (
            <div className={styles.fieldHint} style={{ color: "var(--red)" }}>
              {addError}
            </div>
          )}
        </Stack>
      )}
      <div className={styles.fieldHint}>
        The machine this project's files, git and terminals live on. Moving it
        does not move existing worktrees or panes.
      </div>
    </Stack>
  );
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

type ProjectSettingsPageProps = {
  project: ProjectInfo;
};

export function ProjectSettingsPage(props: ProjectSettingsPageProps) {
  const { project } = props;

  const updateProject = useProjectStore((s) => s.updateProject);
  const nameRef = useRef<HTMLInputElement>(null);
  const agentCommandRef = useRef<HTMLInputElement>(null);
  const worktreePathRef = useRef<HTMLInputElement>(null);
  const fieldRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});
  const [newCommandId, setNewCommandId] = useState<string | null>(null);

  const handleBlur = useCallback(
    (
      field:
        | "name"
        | "agentCommand"
        | "worktreePath"
        | "defaultRunCommand"
        | "worktreeStartScript"
        | "worktreeTeardownScript",
    ) => {
      if (field === "name") {
        const el = nameRef.current;
        if (!el) return;
        const trimmed = el.value.trim();
        if (trimmed && trimmed !== project.name) {
          updateProject(project.id, { name: trimmed });
        }
      } else if (field === "agentCommand") {
        const el = agentCommandRef.current;
        if (!el) return;
        const normalized = el.value.trim() || null;
        if (normalized !== (project.agentCommand ?? null)) {
          updateProject(project.id, { agentCommand: normalized });
        }
      } else if (field === "worktreePath") {
        const el = worktreePathRef.current;
        if (!el) return;
        const normalized = el.value.trim() || null;
        if (normalized !== (project.worktreePath ?? null)) {
          updateProject(project.id, { worktreePath: normalized });
        }
      } else {
        const el = fieldRefs.current[field];
        if (!el) return;
        const normalized = el.value.trim() || null;
        if (normalized !== (project[field] ?? null)) {
          updateProject(project.id, { [field]: normalized });
        }
      }
    },
    [project, updateProject],
  );

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
    <Stack className={styles.pageContent}>
      <Stack gap="xs">
        <SectionTitle id="project-general">General</SectionTitle>
        <label className={styles.fieldLabel}>Name</label>
        <Input
          ref={nameRef}
          defaultValue={project.name}
          onBlur={() => handleBlur("name")}
        />
        <label className={styles.fieldLabel}>Path</label>
        <div className={styles.fieldStatic}>{project.path}</div>
        <label className={styles.fieldLabel}>Default Branch</label>
        <div className={styles.fieldStatic}>{project.defaultBranch}</div>
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
        <ProjectThemeSelector project={project} />
      </Stack>

      <LinearProjectSection project={project} />

      <ProjectHostSection project={project} />

      <Stack gap="xs">
        <SectionTitle id="project-agent">Agent</SectionTitle>
        <label className={styles.fieldLabel}>Agent Command</label>
        <Input
          ref={agentCommandRef}
          defaultValue={project.agentCommand ?? ""}
          onBlur={() => handleBlur("agentCommand")}
          placeholder={DEFAULT_AGENT_COMMAND}
        />
      </Stack>

      <Stack gap="xs">
        <SectionTitle id="project-ports">Ports</SectionTitle>
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

      <Stack gap="xl">
        <SectionTitle id="project-worktrees">Worktrees</SectionTitle>
        <Stack gap="xs">
          <label className={styles.fieldLabel}>Worktree Path</label>
          <Input
            ref={worktreePathRef}
            defaultValue={project.worktreePath ?? ""}
            onBlur={() => handleBlur("worktreePath")}
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
              ref={(el) => {
                fieldRefs.current[field] = el;
              }}
              monospace
              defaultValue={project[field] ?? ""}
              onBlur={() => handleBlur(field)}
              placeholder={placeholder}
              rows={4}
            />
          </Stack>
        ))}
      </Stack>
    </Stack>
  );
}
