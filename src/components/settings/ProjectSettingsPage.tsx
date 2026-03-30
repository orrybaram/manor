import { useRef, useCallback, useState, useMemo } from "react";
import Check from "lucide-react/dist/esm/icons/check";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import Plus from "lucide-react/dist/esm/icons/plus";
import {
  useProjectStore,
  type ProjectInfo,
  type CustomCommand,
} from "../../store/project-store";
import { useThemeStore, type Theme } from "../../store/theme-store";
import { useMountEffect } from "../../hooks/useMountEffect";
import { LinearProjectSection } from "./LinearProjectSection";
import { DEFAULT_AGENT_COMMAND } from "../../agent-defaults";
import { PROJECT_COLORS } from "../../project-colors";
import { Input, Textarea } from "@/components/ui/Input";
import styles from "./SettingsModal/SettingsModal.module.css";

const scriptFields: Array<{
  field: "defaultRunCommand";
  label: string;
  placeholder: string;
}> = [
  {
    field: "defaultRunCommand",
    label: "Default Run Command",
    placeholder: "e.g. npm run dev",
  },
];

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

  return (
    <div>
      <label className={styles.fieldLabel}>Theme</label>
      <Input
        className={styles.themeSearch}
        type="text"
        placeholder="Search themes..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div style={{ maxHeight: 300, overflowY: "auto" }}>
        <div className={styles.themeList}>
          {filtered.map((entry) => {
            const isSelected = entry.name === selectedName;
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
                className={`${styles.themeItem} ${isSelected ? styles.themeItemSelected : ""}`}
                onClick={() => handleSelect(entry.name)}
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
                  <div className={styles.themePreview}>
                    {dotColors.map((c, i) => (
                      <div
                        key={i}
                        className={styles.colorDot}
                        style={{ background: c }}
                      />
                    ))}
                  </div>
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

  return (
    <div className={styles.pageContent}>
      <div className={styles.settingsGroup}>
        <div className={styles.sectionTitle}>General</div>
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
        <div className={styles.colorPicker}>
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
        </div>
        <ProjectThemeSelector project={project} />
      </div>

      <LinearProjectSection project={project} />

      <div className={styles.settingsGroup}>
        <div className={styles.sectionTitle}>Agent</div>
        <label className={styles.fieldLabel}>Agent Command</label>
        <Input
          ref={agentCommandRef}
          defaultValue={project.agentCommand ?? ""}
          onBlur={() => handleBlur("agentCommand")}
          placeholder={DEFAULT_AGENT_COMMAND}
        />
      </div>

      <div className={styles.settingsGroup}>
        <div className={styles.sectionTitle}>Commands</div>
        <div className={styles.commandList}>
          {(project.commands ?? []).map((cmd: CustomCommand) => (
            <div key={cmd.id} className={styles.commandRow}>
              <input
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
              <input
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
      </div>

      <div className={styles.settingsGroup}>
        <div className={styles.sectionTitle}>Worktrees</div>
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
        {worktreeScriptFields.map(({ field, label, placeholder }) => (
          <div key={field}>
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
          </div>
        ))}
      </div>

      <div className={styles.settingsGroup}>
        <div className={styles.sectionTitle}>Scripts</div>
        {scriptFields.map(({ field, label, placeholder }) => (
          <div key={field}>
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
          </div>
        ))}
      </div>
    </div>
  );
}
