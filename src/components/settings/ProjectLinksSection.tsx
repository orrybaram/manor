import { useMemo } from "react";
import Cloud from "lucide-react/dist/esm/icons/cloud";
import Laptop from "lucide-react/dist/esm/icons/laptop";
import { useProjectStore, type ProjectInfo } from "../../store/project-store";
import { useHostStore } from "../../store/host-store";
import { isRemoteHost, memberHostName, remoteHostOptions } from "../../lib/hosts";
import { canLinkLocalFolder, linkChoices } from "../../utils/sidebar-items";
import { Button } from "../ui/Button/Button";
import { SearchableSelect } from "../ui/SearchableSelect/SearchableSelect";
import { Stack, Row } from "../ui/Layout/Layout";
import { SectionTitle } from "./SectionTitle";
import styles from "./SettingsModal/SettingsModal.module.css";

type ProjectLinksSectionProps = {
  project: ProjectInfo;
  /** The project's group members in section order; empty when unlinked. */
  members: ProjectInfo[];
};

/**
 * Link and Unlink from project settings (ADR-192): the same choices as the
 * sidebar's "Link with…" menu. On a group's page (ADR-193) it also lists the
 * members with an Unlink each, and "Unlink all".
 */
export function ProjectLinksSection(props: ProjectLinksSectionProps) {
  const { project, members } = props;

  const projects = useProjectStore((s) => s.projects);
  const linkProjects = useProjectStore((s) => s.linkProjects);
  const linkLocalFolder = useProjectStore((s) => s.linkLocalFolder);
  const unlinkProject = useProjectStore((s) => s.unlinkProject);
  const unlinkGroup = useProjectStore((s) => s.unlinkGroup);
  const hosts = useHostStore((s) => s.hosts);

  const choices = useMemo(() => linkChoices(project, projects), [project, projects]);
  // `project` is the group's lead member on a group page, or the lone
  // project itself — eligible only when it (so, when grouped, the group) has
  // no local member yet (ADR-193 ticket 4).
  const localFolderEligible = useMemo(
    () => canLinkLocalFolder(project, projects),
    [project, projects],
  );
  const options = useMemo(() => {
    const remoteNames = new Map(remoteHostOptions(hosts).map((o) => [o.value, o.label]));
    const hostName = (hostId: string) =>
      isRemoteHost(hostId) ? (remoteNames.get(hostId) ?? hostId) : "this machine";
    return choices.map((choice) => ({
      value: choice.key,
      label: `${choice.label} (${choice.hostIds.map(hostName).join(", ")})`,
    }));
  }, [choices, hosts]);

  const handleLink = (key: string) => {
    const choice = choices.find((c) => c.key === key);
    if (choice) void linkProjects(project.id, choice.targetId);
  };

  return (
    <Stack gap="md">
      <Stack gap="xs">
        <SectionTitle id="project-links">Linked projects</SectionTitle>
        <div className={styles.sectionDescription}>
          {project.group
            ? "One sidebar entry with a section per host. Unlinking a project keeps the shared settings as its own."
            : "Link this project with a clone of the same repo on another host to show both as one sidebar entry with shared settings."}
        </div>
      </Stack>
      {project.group && (
        <Stack gap="sm">
          <div className={styles.linkedMemberList}>
            {members.map((member) => {
              const HostIcon = isRemoteHost(member.hostId) ? Cloud : Laptop;
              return (
                <Row
                  key={member.id}
                  gap="md"
                  align="center"
                  className={styles.linkedMemberRow}
                >
                  <HostIcon size={14} aria-hidden className={styles.linkedMemberIcon} />
                  <Stack gap="2xs" className={styles.linkedMemberText}>
                    <span className={styles.linkedMemberHost}>
                      {memberHostName(member.hostId, hosts)}
                    </span>
                    <span className={styles.linkedMemberPath} title={member.path}>
                      {member.path}
                    </span>
                  </Stack>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void unlinkProject(member.id)}
                  >
                    Unlink
                  </Button>
                </Row>
              );
            })}
          </div>
          <div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                if (project.group) void unlinkGroup(project.group.id);
              }}
            >
              Unlink all
            </Button>
          </div>
        </Stack>
      )}
      <Stack gap="xs">
        <label className={styles.fieldLabel}>Link with</label>
        <Row gap="sm" align="center">
          <SearchableSelect
            value=""
            onChange={handleLink}
            options={options}
            placeholder={choices.length > 0 ? "Choose a project…" : "No project to link"}
            emptyMessage="No project on another host to link"
            maxWidth={320}
          />
          {localFolderEligible && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void linkLocalFolder(project.id)}
            >
              Choose local folder…
            </Button>
          )}
        </Row>
      </Stack>
    </Stack>
  );
}
