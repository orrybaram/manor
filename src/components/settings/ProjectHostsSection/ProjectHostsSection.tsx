import { useCallback, useMemo, useState } from "react";
import { useProjectStore, type ProjectInfo } from "../../../store/project-store";
import { useHostStore } from "../../../store/host-store";
import { hasHiddenPods, transferTargets } from "../../../lib/transfer-targets";
import { Button } from "../../ui/Button/Button";
import { ConfirmDialog } from "../../ui/ConfirmDialog/ConfirmDialog";
import { SearchableSelect } from "../../ui/SearchableSelect/SearchableSelect";
import { Stack } from "../../ui/Layout/Layout";
import { SectionTitle } from "../SectionTitle";
import { AddSshHostForm } from "../HostsPage/AddSshHostForm";
import { ProjectHostRow } from "./ProjectHostRow";
import hostStyles from "../HostsPage/HostsPage.module.css";
import styles from "../SettingsModal/SettingsModal.module.css";

const ADD_HOST_VALUE = "__add_host__";

type ProjectHostsSectionProps = {
  /** The project, or for one set up on several hosts its lead member. */
  project: ProjectInfo;
  /** Every host's copy of the project in `memberIds` order; `[project]` when alone. At least one. */
  members: ProjectInfo[];
};

/**
 * The hosts a project is set up on (ADR-237 D3): "Set up on…" another host
 * (ADR-214), or a new one through `AddSshHostForm` (ADR-229 D8); one row per
 * host holding what differs there; and "Keep separate…" when on several.
 */
export function ProjectHostsSection(props: ProjectHostsSectionProps) {
  const { project, members } = props;

  const setUpOnHost = useProjectStore((s) => s.setUpOnHost);
  const keepSeparate = useProjectStore((s) => s.keepSeparate);
  const projects = useProjectStore((s) => s.projects);
  const hosts = useHostStore((s) => s.hosts);

  const [showAllHosts, setShowAllHosts] = useState(false);
  const [adding, setAdding] = useState(false);
  const [confirmingSeparate, setConfirmingSeparate] = useState(false);

  // Every host the project can be set up on (ADR-214), plus a way to add one.
  const options = useMemo(
    () => [
      ...transferTargets(project, projects, hosts, "copy", { showAllHosts })
        .filter((t) => !t.disabledReason)
        .map((t) => ({ value: t.hostId, label: t.label })),
      { value: ADD_HOST_VALUE, label: "Add new host…" },
    ],
    [project, projects, hosts, showAllHosts],
  );
  const hiddenPods = hasHiddenPods(project, hosts);

  const handleSelect = useCallback(
    (value: string) => {
      if (value === ADD_HOST_VALUE) {
        setAdding(true);
        return;
      }
      void setUpOnHost(project.id, value);
    },
    [setUpOnHost, project.id],
  );

  const handleAdded = useCallback(
    (hostId: string) => {
      setAdding(false);
      void setUpOnHost(project.id, hostId);
    },
    [setUpOnHost, project.id],
  );

  const onSeveralHosts = members.length > 1;
  const name = project.group?.name ?? project.name;

  return (
    <Stack gap="xs">
      <div className={styles.sectionHeader}>
        <SectionTitle id="project-host">Hosts</SectionTitle>
        <SearchableSelect
          value=""
          placeholder="Set up on…"
          onChange={handleSelect}
          options={options}
          maxWidth={200}
          data-testid="project-host-select"
        />
      </div>
      <div className={styles.fieldHint}>
        Where this project is set up. Each host keeps its own path, worktrees and ports.
      </div>
      <div className={hostStyles.hostList}>
        {members.map((member) => (
          <ProjectHostRow
            key={member.id}
            member={member}
            memberCount={members.length}
            defaultOpen={members.length === 1}
          />
        ))}
      </div>
      {hiddenPods && (
        <div>
          <Button
            variant="link"
            data-testid="project-host-show-all-hosts"
            onClick={() => setShowAllHosts((v) => !v)}
          >
            {showAllHosts ? "Hide other projects' hosts" : "Show all hosts"}
          </Button>
        </div>
      )}
      {adding && (
        <AddSshHostForm onAdded={handleAdded} onCancel={() => setAdding(false)} />
      )}
      {onSeveralHosts && (
        <>
          <div>
            <Button variant="ghost" size="sm" onClick={() => setConfirmingSeparate(true)}>
              Keep separate…
            </Button>
          </div>
          <ConfirmDialog
            open={confirmingSeparate}
            title="Keep separate?"
            description={`Split ${name} into a separate project per host? Manor won't join them again.`}
            confirmLabel="Keep separate"
            onConfirm={() => {
              setConfirmingSeparate(false);
              void keepSeparate(project.id);
            }}
            onCancel={() => setConfirmingSeparate(false)}
          />
        </>
      )}
    </Stack>
  );
}
