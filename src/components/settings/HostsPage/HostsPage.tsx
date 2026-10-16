import { useState } from "react";
import Pencil from "lucide-react/dist/esm/icons/pencil";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import { useMountEffect } from "../../../hooks/useMountEffect";
import { useHostProfileStore, openProfileEditor } from "../../../store/host-profile-store";
import type { HostProfile, TemplateInfo } from "../../../electron.d";
import Plus from "lucide-react/dist/esm/icons/plus";
import { useHostStore } from "../../../store/host-store";
import { hostName } from "../../../lib/hosts";
import { isWebApp } from "../../../lib/platform";
import { Button } from "../../ui/Button/Button";
import { ConfirmDialog } from "../../ui/ConfirmDialog/ConfirmDialog";
import { Row, Stack } from "../../ui/Layout/Layout";
import { Tooltip } from "../../ui/Tooltip/Tooltip";
import { SectionTitle } from "../SectionTitle";
import { AddHostDialog } from "./AddHostDialog";
import { HostRow } from "./HostRow";
import { ProfileEditorDialog } from "./ProfileEditorDialog";
import { ThisMacRow } from "./ThisMacRow";
import settingsStyles from "../SettingsModal/SettingsModal.module.css";
import styles from "./HostsPage.module.css";
import { profileSummary, REMOVE_PROFILE_TEXT } from "./host-settings-text";

/**
 * Settings → Hosts (ADR-229 D8): every host Manor runs workspaces on, each a
 * collapsible row holding all of its settings (ADR-233 D1, D2) — this
 * computer first, with its remote-control switch, then each remote host's
 * device access, supervision, integrations, Wake, Stop, Remove — and **Add a
 * host…** (D4): an SSH box, or a host Manor starts from a template or a
 * custom recipe.
 *
 * Adding, stopping, supervising and removing are this desktop's alone
 * (`localOnly`), so a browser sees the list and can wake a host, no more.
 */
export function HostsPage() {
  const hosts = useHostStore((s) => s.hosts);
  const remote = hosts.filter((h) => h.spec !== null);
  const readOnly = isWebApp();

  return (
    <Stack gap="sm" data-testid="hosts-page">
      <SectionTitle id="hosts-list">Hosts</SectionTitle>
      <div className={settingsStyles.fieldHint}>
        Where your projects' files, git, terminals and agents run.
      </div>
      <div className={styles.hostList}>
        <ThisMacRow />
        {remote.map((host) => (
          <HostRow key={host.hostId} host={host} name={hostName(host)} readOnly={readOnly} />
        ))}
      </div>
      {!readOnly && <AddHost />}
      {!readOnly && <Profiles />}
    </Stack>
  );
}

/** "Add a host…": opens the wizard (ADR-233 D4). */
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
 * "Profiles" (ADR-235 D2): the recipes and answers a project gets its own
 * host from. Edited in the profile editor; removing one leaves its hosts be.
 */
function Profiles() {
  const profiles = useHostProfileStore((s) => s.profiles);
  const remove = useHostProfileStore((s) => s.remove);
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [removing, setRemoving] = useState<HostProfile | null>(null);

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
        A saved template and its answers. A project can get its own host from one.
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
                    onClick={() => setRemoving(profile)}
                  >
                    <Trash2 size={12} aria-hidden />
                  </Button>
                </Tooltip>
              </Row>
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
      <ProfileEditorDialog />
      <ConfirmDialog
        open={removing !== null}
        title={removing ? `Remove ${removing.name}?` : "Remove profile?"}
        description={REMOVE_PROFILE_TEXT}
        confirmLabel="Remove"
        confirmVariant="danger"
        onCancel={() => setRemoving(null)}
        onConfirm={async () => {
          if (removing) await remove(removing.id);
          setRemoving(null);
        }}
      />
    </Stack>
  );
}
