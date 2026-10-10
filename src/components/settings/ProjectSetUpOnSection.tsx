import { useState } from "react";
import Cloud from "lucide-react/dist/esm/icons/cloud";
import Laptop from "lucide-react/dist/esm/icons/laptop";
import { useProjectStore, type ProjectInfo } from "../../store/project-store";
import { useHostStore } from "../../store/host-store";
import { isRemoteHost, memberHostName } from "../../lib/hosts";
import { Button } from "../ui/Button/Button";
import { ConfirmDialog } from "../ui/ConfirmDialog/ConfirmDialog";
import { Stack, Row } from "../ui/Layout/Layout";
import { SectionTitle } from "./SectionTitle";
import styles from "./SettingsModal/SettingsModal.module.css";

type ProjectSetUpOnSectionProps = {
  project: ProjectInfo;
  /** The project's group members in section order; empty when set up on one host. */
  members: ProjectInfo[];
};

/**
 * The hosts a project is set up on (ADR-214), each with "Remove from <host>",
 * and "Keep separate…" for a project set up on more than one.
 */
export function ProjectSetUpOnSection(props: ProjectSetUpOnSectionProps) {
  const { project, members } = props;

  const openRemoveFromHost = useProjectStore((s) => s.openRemoveFromHost);
  const keepSeparate = useProjectStore((s) => s.keepSeparate);
  const hosts = useHostStore((s) => s.hosts);
  const [confirmingSeparate, setConfirmingSeparate] = useState(false);

  const setUpOn = project.group ? members : [project];
  const onSeveralHosts = setUpOn.length > 1;
  const name = project.group?.name ?? project.name;

  return (
    <Stack gap="md">
      <Stack gap="xs">
        <SectionTitle id="project-links">Hosts</SectionTitle>
        <div className={styles.sectionDescription}>
          {onSeveralHosts
            ? "Where this project is set up. Removing it from a host doesn't delete its files."
            : "This project is set up on one host. Use Set up on… in the host settings to add another."}
        </div>
      </Stack>
      <div className={styles.linkedMemberList}>
        {setUpOn.map((member) => {
          const HostIcon = isRemoteHost(member.hostId) ? Cloud : Laptop;
          const hostName = memberHostName(member.hostId, hosts);
          return (
            <Row key={member.id} gap="md" align="center" className={styles.linkedMemberRow}>
              <HostIcon size={14} aria-hidden className={styles.linkedMemberIcon} />
              <Stack gap="2xs" className={styles.linkedMemberText}>
                <span className={styles.linkedMemberHost}>{hostName}</span>
                <span className={styles.linkedMemberPath} title={member.path}>
                  {member.path}
                </span>
              </Stack>
              {onSeveralHosts && (
                <Button variant="ghost" size="sm" onClick={() => openRemoveFromHost(member.id)}>
                  Remove from {hostName}
                </Button>
              )}
            </Row>
          );
        })}
      </div>
      {onSeveralHosts && (
        <div>
          <Button variant="ghost" size="sm" onClick={() => setConfirmingSeparate(true)}>
            Keep separate…
          </Button>
        </div>
      )}
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
    </Stack>
  );
}
