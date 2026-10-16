import { useState } from "react";
import Plus from "lucide-react/dist/esm/icons/plus";
import { useHostStore } from "../../../store/host-store";
import { hostName } from "../../../lib/hosts";
import { isWebApp } from "../../../lib/platform";
import { Button } from "../../ui/Button/Button";
import { Stack } from "../../ui/Layout/Layout";
import { SectionTitle } from "../SectionTitle";
import { AddHostDialog } from "./AddHostDialog";
import { HostRow } from "./HostRow";
import { ThisMacRow } from "./ThisMacRow";
import settingsStyles from "../SettingsModal/SettingsModal.module.css";
import styles from "./HostsPage.module.css";

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
