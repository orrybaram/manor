import { useRef, useCallback, useEffect, useMemo, useState } from "react";
import { useProjectStore, type ProjectInfo } from "../../../store/project-store";
import { useAppStore } from "../../../store/app-store";
import { useHostStore, selectHost } from "../../../store/host-store";
import { useHostDisplay } from "../../../hooks/useHostDisplay";
import { HostIndicator } from "../../hosts/HostIndicator";
import { LOCAL_HOST_ID, isRemoteHost, remoteHostOptions } from "../../../lib/hosts";
import { ipcErrorMessage } from "../../../lib/ipc-error";
import { CloneToHostDialog } from "../CloneToHostDialog/CloneToHostDialog";
import { Input } from "../../ui/Input";
import { Button } from "../../ui/Button/Button";
import { SearchableSelect } from "../../ui/SearchableSelect/SearchableSelect";
import { ConfirmDialog } from "../../ui/ConfirmDialog/ConfirmDialog";
import { Stack, Row } from "../../ui/Layout/Layout";
import { SectionTitle } from "../SectionTitle";
import styles from "../SettingsModal/SettingsModal.module.css";

const ADD_HOST_VALUE = "__add_host__";

/** Whether any workspace of `project` has an open tab in this window. */
function projectHasOpenPanes(
  project: ProjectInfo,
  workspaceLayouts: Record<string, { panels: Record<string, { tabs: unknown[] }> }>,
): boolean {
  return project.workspaces.some((ws) => {
    const layout = workspaceLayouts[ws.path];
    if (!layout) return false;
    return Object.values(layout.panels).some((panel) => panel.tabs.length > 0);
  });
}

/** A host change waiting on the "this project has open panes" confirm. */
type PendingHostChange =
  | { kind: "switch"; hostId: string }
  | { kind: "add"; target: string };

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
  const hosts = useHostStore((s) => s.hosts);
  const addHost = useHostStore((s) => s.addHost);
  const hostBusy = useHostStore((s) => s.busy);
  const workspaceLayouts = useAppStore((s) => s.workspaceLayouts);

  const [adding, setAdding] = useState(false);
  const [targetInput, setTargetInput] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [switchFailedHostId, setSwitchFailedHostId] = useState<string | null>(
    null,
  );
  const [pendingChange, setPendingChange] = useState<PendingHostChange | null>(
    null,
  );
  /** The host id `CloneToHostDialog` is open for, or null when it is closed. */
  const [cloneDialogHostId, setCloneDialogHostId] = useState<string | null>(
    null,
  );
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

  const options = useMemo(() => {
    return [
      { value: LOCAL_HOST_ID, label: "Local (this machine)" },
      ...remoteHostOptions(hosts),
      { value: ADD_HOST_VALUE, label: "Add new host…" },
    ];
  }, [hosts]);

  // Main moves the project's path along with its host — to `path`, or the
  // path it last had there — and refuses when that path is missing there.
  const switchHost = useCallback(
    (hostId: string, path?: string) => {
      setSwitchError(null);
      setSwitchFailedHostId(null);
      switchProjectHost(project.id, hostId, path).catch((err: unknown) => {
        setSwitchError(ipcErrorMessage(err));
        setSwitchFailedHostId(hostId);
      });
    },
    [project.id, switchProjectHost],
  );

  // No remembered local path (e.g. a project moved to a host before paths
  // were remembered): let the user point it at a checkout on this Mac.
  const chooseLocalFolder = useCallback(async () => {
    const selected = await window.electronAPI.dialog.openDirectory();
    if (selected) switchHost(LOCAL_HOST_ID, selected);
  }, [switchHost]);

  const addAndOpenCloneDialog = useCallback(
    (target: string) => {
      setAddError(null);
      addHost(target)
        .then(({ hostId }) => {
          setAdding(false);
          setTargetInput("");
          setCloneDialogHostId(hostId);
        })
        .catch((err: unknown) => {
          setAddError(ipcErrorMessage(err));
        });
    },
    [addHost],
  );

  const performHostChange = useCallback(
    (change: PendingHostChange) => {
      if (change.kind === "switch") {
        // Local stays a plain host switch, which goes through the ADR-179
        // guard; a remote host opens the clone dialog instead of switching
        // straight away, so the project's path is always valid there first.
        if (change.hostId === LOCAL_HOST_ID) switchHost(change.hostId);
        else setCloneDialogHostId(change.hostId);
      } else {
        addAndOpenCloneDialog(change.target);
      }
    },
    [switchHost, addAndOpenCloneDialog],
  );

  // Confirm BEFORE anything happens — in particular before `addHost`, so
  // cancelling never leaves a registered host reconnecting in the background.
  const requestHostChange = useCallback(
    (change: PendingHostChange) => {
      if (projectHasOpenPanes(project, workspaceLayouts)) {
        setPendingChange(change);
        return;
      }
      performHostChange(change);
    },
    [performHostChange, project, workspaceLayouts],
  );

  const handleSelect = useCallback(
    (value: string) => {
      if (value === ADD_HOST_VALUE) {
        setAdding(true);
        setAddError(null);
        requestAnimationFrame(() => targetInputRef.current?.focus());
        return;
      }
      if (value === currentHostId) return;
      requestHostChange({ kind: "switch", hostId: value });
    },
    [currentHostId, requestHostChange],
  );

  const handleAddHost = useCallback(() => {
    const target = targetInput.trim();
    if (!target) return;
    requestHostChange({ kind: "add", target });
  }, [requestHostChange, targetInput]);

  const display = useHostDisplay(currentHostId);

  return (
    <Stack gap="xs">
      <SectionTitle id={sectionId}>Host</SectionTitle>
      <label className={styles.fieldLabel}>Host</label>
      <SearchableSelect
        value={currentHostId}
        onChange={handleSelect}
        options={options}
        maxWidth={320}
      />
      {switchError && (
        <Row gap="xs" align="center">
          <span className={styles.fieldHint} style={{ color: "var(--red)" }}>
            Couldn't switch host: {switchError}
          </span>
          {switchFailedHostId === LOCAL_HOST_ID && (
            <Button variant="secondary" size="sm" onClick={chooseLocalFolder}>
              Choose local folder…
            </Button>
          )}
        </Row>
      )}
      {display && (
        <Stack gap="2xs">
          <Row gap="xs" align="center">
            <HostIndicator hostId={currentHostId} variant="chip" />
            {!display.offline && (
              <span className={styles.fieldHint}>{display.status}</span>
            )}
          </Row>
          {display.detail && (
            <span
              className={styles.fieldHint}
              style={
                display.tone === "error"
                  ? { color: "var(--red)" }
                  : display.tone === "warn"
                    ? { color: "var(--yellow)" }
                    : undefined
              }
            >
              {display.detail}
            </span>
          )}
        </Stack>
      )}
      {pathMissing && hostConnected && (
        <Row gap="xs" align="center">
          <span className={styles.fieldHint} style={{ color: "var(--yellow)" }}>
            Repository not found on this host
          </span>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setCloneDialogHostId(currentHostId)}
          >
            Clone onto host…
          </Button>
        </Row>
      )}
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
      <div className={styles.fieldHint}>
        The machine this project's files, git and terminals live on. Moving it
        does not move existing worktrees; their tabs close.
      </div>
      <ConfirmDialog
        open={pendingChange !== null}
        title="Switch this project's host?"
        description={
          "This project has open tabs. Switching its host closes them and " +
          "stops their terminals, including any running agents. New tabs " +
          "open on the new host."
        }
        confirmLabel={
          pendingChange?.kind === "switch" && pendingChange.hostId === LOCAL_HOST_ID
            ? "Switch host"
            : "Continue"
        }
        onConfirm={() => {
          const change = pendingChange;
          setPendingChange(null);
          if (change) performHostChange(change);
        }}
        onCancel={() => setPendingChange(null)}
      />
      {cloneDialogHostId && (
        <CloneToHostDialog
          open
          project={project}
          hostId={cloneDialogHostId}
          onClose={() => setCloneDialogHostId(null)}
        />
      )}
    </Stack>
  );
}
