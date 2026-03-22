import { useRef, useCallback } from "react";
import { Check } from "lucide-react";
import { useProjectStore, type ProjectInfo } from "../store/project-store";
import { LinearProjectSection } from "./LinearProjectSection";
import styles from "./SettingsModal.module.css";

const PROJECT_COLORS = [
  { value: null, label: "Default", cssVar: "--accent" },
  { value: "red", label: "Red", cssVar: "--red" },
  { value: "green", label: "Green", cssVar: "--green" },
  { value: "yellow", label: "Yellow", cssVar: "--yellow" },
  { value: "blue", label: "Blue", cssVar: "--blue" },
  { value: "magenta", label: "Magenta", cssVar: "--magenta" },
  { value: "cyan", label: "Cyan", cssVar: "--cyan" },
] as const;

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

function defaultWorktreePath(projectName: string): string {
  const slug = projectName
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `~/.manor/worktrees/${slug}`;
}

export function ProjectSettingsPage({ project }: { project: ProjectInfo }) {
  const updateProject = useProjectStore((s) => s.updateProject);
  const nameRef = useRef<HTMLInputElement>(null);
  const agentCommandRef = useRef<HTMLInputElement>(null);
  const worktreePathRef = useRef<HTMLInputElement>(null);
  const fieldRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});

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
        <input
          ref={nameRef}
          className={styles.fieldInput}
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
                {isSelected && <Check size={10} strokeWidth={3} color="var(--bg)" />}
              </button>
            );
          })}
        </div>
      </div>

      <div className={styles.settingsGroup}>
        <div className={styles.sectionTitle}>Agent</div>
        <label className={styles.fieldLabel}>Agent Command</label>
        <input
          ref={agentCommandRef}
          className={styles.fieldInput}
          defaultValue={project.agentCommand ?? ""}
          onBlur={() => handleBlur("agentCommand")}
          placeholder="claude --dangerously-skip-permissions"
        />
      </div>

      <div className={styles.settingsGroup}>
        <div className={styles.sectionTitle}>Worktrees</div>
        <label className={styles.fieldLabel}>Worktree Path</label>
        <input
          ref={worktreePathRef}
          className={styles.fieldInput}
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
            <textarea
              ref={(el) => {
                fieldRefs.current[field] = el;
              }}
              className={`${styles.fieldInput} ${styles.fieldTextarea}`}
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
            <textarea
              ref={(el) => {
                fieldRefs.current[field] = el;
              }}
              className={`${styles.fieldInput} ${styles.fieldTextarea}`}
              defaultValue={project[field] ?? ""}
              onBlur={() => handleBlur(field)}
              placeholder={placeholder}
              rows={4}
            />
          </div>
        ))}
      </div>

      <LinearProjectSection project={project} />
    </div>
  );
}
