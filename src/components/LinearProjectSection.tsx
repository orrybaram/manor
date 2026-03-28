import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronDown } from "lucide-react";
import { useProjectStore, type ProjectInfo } from "../store/project-store";
import { useMountEffect } from "../hooks/useMountEffect";
import styles from "./SettingsModal.module.css";

type LinearProjectSectionProps = {
  project: ProjectInfo;
};

export function LinearProjectSection(props: LinearProjectSectionProps) {
  const { project } = props;

  const [connected, setConnected] = useState(false);
  const [teams, setTeams] = useState<
    Array<{ id: string; name: string; key: string }>
  >([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const updateProject = useProjectStore((s) => s.updateProject);

  const selectedIds = new Set(project.linearAssociations.map((a) => a.teamId));

  useMountEffect(() => {
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
  });

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
