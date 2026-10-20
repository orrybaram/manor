import { useState } from "react";
import Pencil from "lucide-react/dist/esm/icons/pencil";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import { useMountEffect } from "../../../hooks/useMountEffect";
import { useHostProfileStore, openProfileEditor } from "../../../store/host-profile-store";
import type { HostProfile, TemplateInfo } from "../../../electron.d";
import Plus from "lucide-react/dist/esm/icons/plus";
import { useHostStore, type HostStatusInfo } from "../../../store/host-store";
import { hostName } from "../../../lib/hosts";
import { groupHostsByProfile, runningSummary, type HostGroup } from "../../../lib/host-groups";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import { isWebApp } from "../../../lib/platform";
import { Button } from "../../ui/Button/Button";
import { ConfirmDialog } from "../../ui/ConfirmDialog/ConfirmDialog";
import { Row, Stack } from "../../ui/Layout/Layout";
import { Tooltip } from "../../ui/Tooltip/Tooltip";
import { SectionTitle } from "../SectionTitle";
import { AddHostDialog } from "./AddHostDialog";
import { HostRow } from "./HostRow";
import { ThisMacRow } from "./ThisMacRow";
import settingsStyles from "../SettingsModal/SettingsModal.module.css";
import styles from "./HostsPage.module.css";
import { profileSummary, removeProfileText } from "./host-settings-text";

/**
 * Settings → Hosts: every host Manor runs workspaces on, each a
 * collapsible row holding all of its settings — this
 * computer first, with its remote-control switch, then each remote host's
 * device access, supervision, integrations, Wake, Stop, Remove — and **Add a
 * host…**: an SSH box, or a host Manor starts from a template or a
 * custom recipe.
 *
 * Adding, stopping, supervising and removing are this desktop's alone
 * (`localOnly`), so a browser sees the list and can wake a host, no more.
 */
export function HostsPage() {
  const hosts = useHostStore((s) => s.hosts);
  const profiles = useHostProfileStore((s) => s.profiles);
  const remote = hosts.filter((h) => h.spec !== null);
  const { groups, rest } = groupHostsByProfile(remote, profiles);
  const readOnly = isWebApp();

  return (
    <Stack className={settingsStyles.pageContent} data-testid="hosts-page">
      <Stack gap="sm">
        <SectionTitle id="hosts-list">Hosts</SectionTitle>
        <div className={settingsStyles.fieldHint}>
          Where your projects' files, git, terminals and agents run.
        </div>
        <div className={styles.hostList}>
          <ThisMacRow />
          {groups.map((group) => (
            <ProfileGroup key={group.profile.id} group={group} readOnly={readOnly} />
          ))}
          {rest.map((host) => (
            <HostRow key={host.hostId} host={host} name={hostName(host)} readOnly={readOnly} />
          ))}
        </div>
        {!readOnly && <AddHost />}
      </Stack>
      {!readOnly && <Profiles />}
    </Stack>
  );
}

/** "Add a host…": opens the wizard. */
function AddHost() {
  const [open, setOpen] = useState(false);

  return (
    <div>
      <Button
        variant="secondary"
        size="sm"
        data-testid="hosts-add"
        data-settings-section="hosts-add"
        onClick={() => setOpen(true)}
      >
        <Plus size={12} aria-hidden className={styles.buttonIcon} />
        Add a host…
      </Button>
      <AddHostDialog open={open} onClose={() => setOpen(false)} />
    </div>
  );
}

/**
 * "Profiles": the recipes and answers a project gets its own
 * host from. Edited in the profile editor; removing one leaves its hosts be.
 */
function Profiles() {
  const allProfiles = useHostProfileStore((s) => s.profiles);
  const hosts = useHostStore((s) => s.hosts);
  // A profile with hosts is shown above, as the heading of its hosts.
  const profiles = allProfiles.filter((p) => !hosts.some((h) => h.profileId === p.id));
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);

  useMountEffect(() => {
    let live = true;
    void useHostProfileStore.getState().refresh();
    window.electronAPI.hosts.listTemplates().then(
      (list) => {
        if (live) setTemplates(list);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  });

  return (
    <Stack gap="sm" data-testid="host-profiles">
      <SectionTitle id="host-profiles">Profiles</SectionTitle>
      <div className={settingsStyles.fieldHint}>
        A saved template and its answers. A project can get its own host from one. Profiles with
        hosts are listed with them above.
      </div>
      {profiles.length > 0 && (
        <div className={styles.hostList}>
          {profiles.map((profile) => (
            <Row
              key={profile.id}
              gap="xs"
              align="center"
              justify="space-between"
              data-testid={`host-profile-${profile.id}`}
            >
              <div>
                <div>{profile.name}</div>
                <div className={settingsStyles.fieldHint}>
                  {profileSummary(
                    templates.find((t) => t.id === profile.templateId)?.name ?? profile.templateId,
                    profile.values,
                  )}
                </div>
              </div>
              <ProfileActions profile={profile} />
            </Row>
          ))}
        </div>
      )}
      <div>
        <Button
          variant="secondary"
          size="sm"
          data-testid="host-profile-new"
          onClick={() => openProfileEditor()}
        >
          <Plus size={12} aria-hidden className={styles.buttonIcon} />
          New profile…
        </Button>
      </div>
    </Stack>
  );
}

/** Edit / Remove for a profile, wherever its row is shown. */
function ProfileActions(props: { profile: HostProfile }) {
  const { profile } = props;
  const remove = useHostProfileStore((s) => s.remove);
  const [removing, setRemoving] = useState(false);

  return (
    <Row gap="xs">
      <Tooltip label="Edit profile">
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Edit ${profile.name}`}
          data-testid={`host-profile-edit-${profile.id}`}
          onClick={() => openProfileEditor({ profile })}
        >
          <Pencil size={12} aria-hidden />
        </Button>
      </Tooltip>
      <Tooltip label="Remove profile">
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Remove ${profile.name}`}
          data-testid={`host-profile-remove-${profile.id}`}
          onClick={() => setRemoving(true)}
        >
          <Trash2 size={12} aria-hidden />
        </Button>
      </Tooltip>
      <ConfirmDialog
        open={removing}
        title={`Remove ${profile.name}?`}
        description={removeProfileText(profile)}
        confirmLabel="Remove"
        confirmVariant="danger"
        onCancel={() => setRemoving(false)}
        onConfirm={async () => {
          await remove(profile.id);
          setRemoving(false);
        }}
      />
    </Row>
  );
}

const COLLAPSED_KEY = "manor:collapsed-profile-groups";

function readCollapsed(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function writeCollapsed(ids: string[]) {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(ids));
  } catch {
    // Storage unavailable: the group just won't remember.
  }
}

/**
 * A profile's hosts under one collapsible heading: the heading is
 * the profile's own row, with "N of M running" and Edit / Remove. Whether it
 * is collapsed is remembered per profile.
 */
function ProfileGroup(props: { group: HostGroup<HostStatusInfo, HostProfile>; readOnly: boolean }) {
  const { group, readOnly } = props;
  const { profile } = group;
  const [collapsed, setCollapsed] = useState(() => readCollapsed().includes(profile.id));

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    const ids = readCollapsed().filter((id) => id !== profile.id);
    writeCollapsed(next ? [...ids, profile.id] : ids);
  };

  return (
    <div data-testid={`host-profile-group-${profile.id}`}>
      <div className={styles.groupHeader}>
        <Button
          variant="ghost"
          className={styles.groupToggle}
          aria-expanded={!collapsed}
          data-testid={`host-profile-group-toggle-${profile.id}`}
          onClick={toggle}
        >
          <ChevronRight
            size={14}
            aria-hidden
            className={`${styles.chevron} ${collapsed ? "" : styles.chevronOpen}`}
          />
          <span className={styles.groupName}>{profile.name}</span>
          <span className={settingsStyles.fieldHint} data-testid="host-profile-group-summary">
            {runningSummary(group)}
          </span>
        </Button>
        {!readOnly && (
          <div className={styles.rowHeaderActions}>
            <ProfileActions profile={profile} />
          </div>
        )}
      </div>
      {!collapsed &&
        group.hosts.map((host) => (
          <HostRow key={host.hostId} host={host} name={hostName(host)} readOnly={readOnly} />
        ))}
    </div>
  );
}
