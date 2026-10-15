import { useState } from "react";
import Plus from "lucide-react/dist/esm/icons/plus";
import Rocket from "lucide-react/dist/esm/icons/rocket";
import { useHostStore } from "../../../store/host-store";
import { hostName } from "../../../lib/hosts";
import { isWebApp } from "../../../lib/platform";
import { Button } from "../../ui/Button/Button";
import { Row, Stack } from "../../ui/Layout/Layout";
import { HostCard } from "../../hosts/HostCard";
import { SectionTitle } from "../SectionTitle";
import { AddSshHostForm } from "./AddSshHostForm";
import { HostEntry } from "./HostEntry";
import { StartHostForm } from "./StartHostForm";
import settingsStyles from "../SettingsModal/SettingsModal.module.css";

/**
 * Settings → Hosts (ADR-229 D8): every host Manor runs workspaces on, this
 * computer first (read-only), each remote one with its status and what can
 * be done to it — Wake, Stop, "Keep Manor running when <host> restarts",
 * Remove — and **Add host**: an SSH box, or a host Manor starts from a
 * template or a custom recipe.
 *
 * Adding, stopping, supervising and removing are this desktop's alone
 * (`localOnly`), so a browser sees the list and can wake a host, no more.
 */
export function HostsPage() {
  const hosts = useHostStore((s) => s.hosts);
  const remote = hosts.filter((h) => h.spec !== null);
  const readOnly = isWebApp();

  return (
    <Stack gap="lg" data-testid="hosts-page">
      <Stack gap="sm">
        <SectionTitle id="hosts-list">Hosts</SectionTitle>
        <div className={settingsStyles.fieldHint}>
          Where your projects' files, git, terminals and agents run.
        </div>
        <HostCard hostId={null} />
        {remote.map((host) => (
          <HostEntry key={host.hostId} host={host} name={hostName(host)} readOnly={readOnly} />
        ))}
      </Stack>
      {!readOnly && <AddHost />}
    </Stack>
  );
}

/** "Add host": an SSH box, or a host Manor starts. */
function AddHost() {
  const [mode, setMode] = useState<"ssh" | "start" | null>(null);

  return (
    <Stack gap="sm">
      <SectionTitle id="hosts-add">Add host</SectionTitle>
      {mode === null && (
        <>
          <div className={settingsStyles.fieldHint}>
            A machine you already reach over ssh, or one Manor starts for you: a
            container, a pod, a VM.
          </div>
          <Row gap="xs">
            <Button
              variant="secondary"
              size="sm"
              data-testid="hosts-add-ssh"
              onClick={() => setMode("ssh")}
            >
              <Plus size={12} aria-hidden />
              An SSH box
            </Button>
            <Button
              variant="secondary"
              size="sm"
              data-testid="hosts-add-start"
              onClick={() => setMode("start")}
            >
              <Rocket size={12} aria-hidden />
              Start a host
            </Button>
          </Row>
        </>
      )}
      {mode === "ssh" && (
        <AddSshHostForm onAdded={() => setMode(null)} onCancel={() => setMode(null)} />
      )}
      {/* The new host's card above streams its `up`'s progress. */}
      {mode === "start" && (
        <StartHostForm onStarted={() => setMode(null)} onCancel={() => setMode(null)} />
      )}
    </Stack>
  );
}
