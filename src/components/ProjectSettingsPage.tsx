import { useState, useEffect, useRef, useCallback } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronDown } from "lucide-react";
import { useProjectStore, type ProjectInfo } from "../store/project-store";
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

function LinearProjectSection({ project }: { project: ProjectInfo }) {
  const [connected, setConnected] = useState(false);
  const [teams, setTeams] = useState<
    Array<{ id: string; name: string; key: string }>
  >([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const updateProject = useProjectStore((s) => s.updateProject);

  const selectedIds = new Set(project.linearAssociations.map((a) => a.teamId));

  useEffect(() => {
    window.electronAPI.linear.isConnected().then(async (isConnected) => {
      setConnected(isConnected);
      if (isConnected) {
        try {
          const t = await window.electronAPI.linear.getTeams();
          setTeams(t);
        } catch {
          // ignore
        }
      }
      setLoading(false);
    });
  }, []);

  const handleToggleTeam = (team: {
    id: string;
    name: string;
    key: string;
  }) => {
    const current = project.linearAssociations;
    const exists = current.some((a) => a.teamId === team.id);
    const next = exists
      ? current.filter((a) => a.teamId !== team.id)
      : [
          ...current,
          { teamId: team.id, teamName: team.name, teamKey: team.key },
        ];
    updateProject(project.id, { linearAssociations: next });
  };

  if (loading) return null;

  const label =
    selectedIds.size === 0
      ? "Select teams..."
      : project.linearAssociations.map((a) => a.teamKey).join(", ");

  return (
    <div className={styles.settingsGroup}>
      <div className={styles.sectionTitle}>Linear</div>
      {!connected ? (
        <div className={styles.fieldHint}>
          Connect Linear in Integrations to link this project to a team.
        </div>
      ) : (
        <>
          <label className={styles.fieldLabel}>Teams</label>
          <Popover.Root open={open} onOpenChange={setOpen}>
            <Popover.Trigger asChild>
              <button className={styles.multiSelectTrigger}>
                <span className={styles.multiSelectLabel}>{label}</span>
                <ChevronDown size={14} />
              </button>
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content
                className={styles.multiSelectContent}
                sideOffset={4}
                align="start"
              >
                {teams.map((team) => {
                  const isSelected = selectedIds.has(team.id);
                  return (
                    <button
                      key={team.id}
                      className={`${styles.multiSelectItem} ${isSelected ? styles.multiSelectItemSelected : ""}`}
                      onClick={() => handleToggleTeam(team)}
                    >
                      <span className={styles.multiSelectCheck}>
                        {isSelected && <Check size={13} />}
                      </span>
                      <span>
                        {team.key} — {team.name}
                      </span>
                    </button>
                  );
                })}
                {teams.length === 0 && (
                  <div className={styles.multiSelectEmpty}>No teams found</div>
                )}
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
        </>
      )}
    </div>
  );
}
