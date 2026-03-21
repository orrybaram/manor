import { useRef, useCallback } from "react";
import { useProjectStore, type ProjectInfo } from "../store/project-store";
import { LinearProjectSection } from "./LinearProjectSection";
import styles from "./SettingsModal.module.css";

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
  const worktreePathRef = useRef<HTMLInputElement>(null);
  const fieldRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});

  const handleBlur = useCallback(
    (
      field:
        | "name"
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
