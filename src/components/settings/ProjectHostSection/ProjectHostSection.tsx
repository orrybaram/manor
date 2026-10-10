import { useRef, useCallback, useEffect, useMemo, useState } from "react";
import { useProjectStore, type ProjectInfo } from "../../../store/project-store";
import { useHostStore, selectHost } from "../../../store/host-store";
import { HostCard, HostCardRow } from "../../hosts/HostCard";
import { isRemoteHost } from "../../../lib/hosts";
import { transferTargets } from "../../../lib/transfer-targets";
import { ipcErrorMessage } from "../../../lib/ipc-error";
import { Input } from "../../ui/Input";
import { Button } from "../../ui/Button/Button";
import { SearchableSelect } from "../../ui/SearchableSelect/SearchableSelect";
import { Stack, Row } from "../../ui/Layout/Layout";
import { SectionTitle } from "../SectionTitle";
import styles from "../SettingsModal/SettingsModal.module.css";
import { pickDirectory } from "../../../lib/pick-directory";

const ADD_HOST_VALUE = "__add_host__";

type ProjectHostSectionProps = {
  project: ProjectInfo;
  /**
   * The search anchor for this section. A linked group's settings page
   * shows one per member, so all but one need their own (ADR-192).
   */
  sectionId?: string;
};

/**
 * The host this project's paths, git and terminals live on (ADR-160). Local
 * is the default and always available; remote hosts are whatever the user
 * has registered (across every project) plus an inline "add a new one" flow
 * so this is the only place a first remote host has to be reachable from.
 *
 * Moved out of `ProjectSettingsPage.tsx` into its own module (ADR-183
 * ticket 10).
 */
export function ProjectHostSection(props: ProjectHostSectionProps) {
  const { project, sectionId = "project-host" } = props;

  const switchProjectHost = useProjectStore((s) => s.switchProjectHost);
  const transferProject = useProjectStore((s) => s.transferProject);
  const setUpOnHost = useProjectStore((s) => s.setUpOnHost);
  const projects = useProjectStore((s) => s.projects);
  const hosts = useHostStore((s) => s.hosts);
  const addHost = useHostStore((s) => s.addHost);
  const hostBusy = useHostStore((s) => s.busy);

  const [adding, setAdding] = useState(false);
  const [targetInput, setTargetInput] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [repairError, setRepairError] = useState<string | null>(null);
  const [pathMissing, setPathMissing] = useState(false);
  const targetInputRef = useRef<HTMLInputElement>(null);

  const currentHostId = project.hostId;
  const currentHost = useHostStore(selectHost(currentHostId));

  // `projects:pathExists` doesn't connect to the host first — it
  // returns false while disconnected, which would otherwise flash a false
  // "not found" warning. Only trust it once the host reports connected, and
  // re-check whenever that happens (mount, path/host change, reconnect).
  const hostConnected =
    isRemoteHost(currentHostId) && currentHost?.status === "connected";
  useEffect(() => {
    if (!hostConnected) return;
    let cancelled = false;
    window.electronAPI.projects
      .pathExists(project.id)
      .then((exists) => {
        if (!cancelled) setPathMissing(!exists);
      })
      .catch(() => {
        /* leave the previous state — the host status line already covers errors */
      });
    return () => {
      cancelled = true;
    };
  }, [project.id, project.path, hostConnected]);

  // Every host the project can be set up on (ADR-214), plus a way to add one.
  const options = useMemo(
    () => [
      ...transferTargets(project, projects, hosts, "copy")
        .filter((t) => !t.disabledReason)
        .map((t) => ({ value: t.hostId, label: t.label })),
      { value: ADD_HOST_VALUE, label: "Add new host…" },
    ],
    [project, projects, hosts],
  );

  // Repair for a missing repo: re-clone it in place, or point at a folder.
  const cloneAgain = useCallback(
    () => void transferProject(project.id, currentHostId, "move"),
    [transferProject, project.id, currentHostId],
  );
  const pointAtAnotherFolder = useCallback(async () => {
    const selected = await pickDirectory();
    if (!selected) return;
    setRepairError(null);
    try {
      await switchProjectHost(project.id, currentHostId, selected);
    } catch (err) {
      setRepairError(ipcErrorMessage(err));
    }
  }, [switchProjectHost, project.id, currentHostId]);

  const handleSelect = useCallback(
    (value: string) => {
      if (value === ADD_HOST_VALUE) {
        setAdding(true);
        setAddError(null);
        requestAnimationFrame(() => targetInputRef.current?.focus());
        return;
      }
      void setUpOnHost(project.id, value);
    },
    [setUpOnHost, project.id],
  );

  const handleAddHost = useCallback(() => {
    const target = targetInput.trim();
    if (!target) return;
    setAddError(null);
    addHost(target)
      .then(({ hostId }) => {
        setAdding(false);
        setTargetInput("");
        void setUpOnHost(project.id, hostId);
      })
      .catch((err: unknown) => {
        setAddError(ipcErrorMessage(err));
      });
  }, [addHost, setUpOnHost, project.id, targetInput]);

  return (
    <Stack gap="xs">
      <SectionTitle id={sectionId}>Host</SectionTitle>
      <div className={styles.fieldHint}>
        Where this project's files, git and terminals live.
      </div>
      <HostCard
        hostId={currentHostId}
        actions={
          <SearchableSelect
            value=""
            placeholder="Set up on…"
            onChange={handleSelect}
            options={options}
            maxWidth={200}
            data-testid="project-host-select"
          />
        }
      >
        {pathMissing && hostConnected && (
          <HostCardRow tone="warn">
            <span>Repository not found on this host</span>
            <Button variant="secondary" size="sm" onClick={cloneAgain}>
              Clone it again
            </Button>
            <Button variant="secondary" size="sm" onClick={pointAtAnotherFolder}>
              Point at another folder…
            </Button>
          </HostCardRow>
        )}
        {repairError && (
          <HostCardRow tone="error">
            <span>Couldn't use that folder: {repairError}</span>
          </HostCardRow>
        )}
      </HostCard>
      {adding && (
        <Stack gap="xs">
          <Input
            ref={targetInputRef}
            placeholder="user@host or an ssh config alias"
            value={targetInput}
            disabled={hostBusy}
            onChange={(e) => setTargetInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAddHost();
              if (e.key === "Escape") setAdding(false);
            }}
          />
          <Row gap="xs">
            <Button
              variant="secondary"
              size="sm"
              disabled={hostBusy || targetInput.trim() === ""}
              onClick={handleAddHost}
            >
              Connect
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </Row>
          {addError && (
            <div className={styles.fieldHint} style={{ color: "var(--red)" }}>
              {addError}
            </div>
          )}
        </Stack>
      )}
    </Stack>
  );
}
