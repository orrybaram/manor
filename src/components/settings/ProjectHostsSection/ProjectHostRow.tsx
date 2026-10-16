import { useCallback, useEffect, useState } from "react";
import Laptop from "lucide-react/dist/esm/icons/laptop";
import ShieldAlert from "lucide-react/dist/esm/icons/shield-alert";
import { useProjectStore, type ProjectInfo } from "../../../store/project-store";
import { useHostStore, selectHost } from "../../../store/host-store";
import { useMemberDisplayName } from "../../../bridge/server-set";
import { useHostDisplay } from "../../../hooks/useHostDisplay";
import { pendingDisplay } from "../../../lib/host-status";
import { isRemoteHost } from "../../../lib/hosts";
import { ipcErrorMessage } from "../../../lib/ipc-error";
import { pickDirectory } from "../../../lib/pick-directory";
import {
  hostSegments,
  portlessHostFor,
  portlessHostname,
} from "../../../lib/portless-hostname";
import { HostStateIcon } from "../../hosts/HostStateIcon";
import { Button } from "../../ui/Button/Button";
import { Input, Textarea } from "../../ui/Input";
import { Stack } from "../../ui/Layout/Layout";
import { Switch } from "../../ui/Switch/Switch";
import { HostRowShell } from "../HostsPage/HostRow";
import { LOCAL_HOST_SECTION } from "../HostsPage/ThisMacRow";
import { SettingRow } from "../SettingRow";
import { useSettingsNav } from "../SettingsModal/settings-nav";
import { projectHostStatus } from "./project-host-status";
import hostStyles from "../HostsPage/HostsPage.module.css";
import styles from "../SettingsModal/SettingsModal.module.css";

const worktreeScriptFields: Array<{
  field: "worktreeStartScript" | "worktreeTeardownScript";
  label: string;
  placeholder: string;
}> = [
  {
    field: "worktreeStartScript",
    label: "Start Script",
    placeholder: "Runs in the terminal when a new worktree is created",
  },
  {
    field: "worktreeTeardownScript",
    label: "Teardown Script",
    placeholder: "Runs before a worktree is deleted",
  },
];

/**
 * The hostname a project's main workspace gets, by the rules portless routes
 * with — display only. A remote project's carries its host's segment, found
 * among every registered host so a shared prefix shows the full id.
 */
function previewHostname(
  project: Pick<ProjectInfo, "name" | "path" | "hostId">,
  hosts: readonly { hostId: string }[],
): string {
  const remoteIds = hosts.map((h) => h.hostId).filter((id) => isRemoteHost(id));
  // The host list may not have loaded yet; the project's own host is always known.
  if (isRemoteHost(project.hostId) && !remoteIds.includes(project.hostId)) {
    remoteIds.push(project.hostId);
  }
  const host = portlessHostFor(project.hostId, hostSegments(remoteIds));
  return portlessHostname(
    {
      path: project.path,
      projectName: project.name,
      branch: null,
      isMain: true,
    },
    host.kind === "unknown" ? { kind: "local" } : host,
  );
}

function defaultWorktreePath(projectName: string): string {
  const slug = projectName
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `~/.manor/worktrees/${slug}`;
}

type MemberProps = {
  member: ProjectInfo;
};

function WorktreeFields(props: MemberProps) {
  const { member } = props;

  const updateProject = useProjectStore((s) => s.updateProject);

  const saveField = (
    field: "worktreePath" | "worktreeStartScript" | "worktreeTeardownScript",
    value: string,
  ) => {
    const normalized = value.trim() || null;
    if (normalized !== (member[field] ?? null)) {
      updateProject(member.id, { [field]: normalized });
    }
  };

  return (
    <>
      <Stack gap="xs">
        <label className={styles.fieldLabel}>Worktree Path</label>
        <Input
          defaultValue={member.worktreePath ?? ""}
          onBlur={(e) => saveField("worktreePath", e.target.value)}
          placeholder={defaultWorktreePath(member.name)}
        />
        <div className={styles.fieldHint}>
          Directory where new worktrees are created. Defaults to{" "}
          {defaultWorktreePath(member.name)}
        </div>
      </Stack>
      {worktreeScriptFields.map(({ field, label, placeholder }) => (
        <Stack key={field} gap="xs">
          <label className={styles.fieldLabel}>{label}</label>
          <Textarea
            monospace
            defaultValue={member[field] ?? ""}
            onBlur={(e) => saveField(field, e.target.value)}
            placeholder={placeholder}
            rows={4}
          />
        </Stack>
      ))}
    </>
  );
}

function PreviewUrlsField(props: MemberProps) {
  const { member } = props;

  const updateProject = useProjectStore((s) => s.updateProject);
  const hosts = useHostStore((s) => s.hosts);

  return (
    <Stack gap="xs">
      <SettingRow
        label="Named preview URLs"
        hint={
          <>
            Route this project's dev servers through the portless proxy so each
            workspace gets a stable hostname like{" "}
            <code>{previewHostname(member, hosts)}</code>. When off, ports open
            as <code>localhost:&lt;port&gt;</code>.
          </>
        }
      >
        <Switch
          checked={member.portlessEnabled !== false}
          onCheckedChange={(checked) =>
            updateProject(member.id, { portlessEnabled: checked })
          }
        />
      </SettingRow>
    </Stack>
  );
}

/**
 * Repair for a repo a connected remote host reports missing: re-clone it in
 * place, or point at another folder (ADR-237 D3).
 */
function MissingRepoRepair(props: MemberProps) {
  const { member } = props;

  const switchProjectHost = useProjectStore((s) => s.switchProjectHost);
  const transferProject = useProjectStore((s) => s.transferProject);
  const host = useHostStore(selectHost(member.hostId));

  const [repairError, setRepairError] = useState<string | null>(null);
  const [pathMissing, setPathMissing] = useState(false);

  // `projects:pathExists` doesn't connect to the host first — it
  // returns false while disconnected, which would otherwise flash a false
  // "not found" warning. Only trust it once the host reports connected, and
  // re-check whenever that happens (mount, path/host change, reconnect).
  const hostConnected = isRemoteHost(member.hostId) && host?.status === "connected";
  useEffect(() => {
    if (!hostConnected) return;
    let cancelled = false;
    window.electronAPI.projects
      .pathExists(member.id)
      .then((exists) => {
        if (!cancelled) setPathMissing(!exists);
      })
      .catch(() => {
        /* leave the previous state — the host status line already covers errors */
      });
    return () => {
      cancelled = true;
    };
  }, [member.id, member.path, hostConnected]);

  const cloneAgain = useCallback(
    () => void transferProject(member.id, member.hostId, "move"),
    [transferProject, member.id, member.hostId],
  );
  const pointAtAnotherFolder = useCallback(async () => {
    const selected = await pickDirectory();
    if (!selected) return;
    setRepairError(null);
    try {
      await switchProjectHost(member.id, member.hostId, selected);
    } catch (err) {
      setRepairError(ipcErrorMessage(err));
    }
  }, [switchProjectHost, member.id, member.hostId]);

  return (
    <>
      {pathMissing && hostConnected && (
        <div className={styles.remoteWarning}>
          <ShieldAlert size={14} />
          <span>Repository not found on this host</span>
          <Button variant="secondary" size="sm" onClick={cloneAgain}>
            Clone it again
          </Button>
          <Button variant="secondary" size="sm" onClick={pointAtAnotherFolder}>
            Point at another folder…
          </Button>
        </div>
      )}
      {repairError && (
        <div className={styles.linearError}>Couldn't use that folder: {repairError}</div>
      )}
    </>
  );
}

type ProjectHostRowProps = {
  /** The project as set up on this host. */
  member: ProjectInfo;
  /** How many hosts the project is set up on. */
  memberCount: number;
  defaultOpen: boolean;
};

/**
 * One host a project is set up on (ADR-237 D3): the host and the project's
 * path there in the header, and behind it what differs per host — default
 * branch, worktrees, preview URLs and a missing repo's repair.
 *
 * Its section is `project-host-<projectId>`, so a link can open it.
 */
export function ProjectHostRow(props: ProjectHostRowProps) {
  const { member, memberCount, defaultOpen } = props;

  const hosts = useHostStore((s) => s.hosts);
  const openRemoveFromHost = useProjectStore((s) => s.openRemoveFromHost);
  const goTo = useSettingsNav();
  const name = useMemberDisplayName(member.hostId, hosts);
  const display = useHostDisplay(member.hostId);
  const { word, tone } = projectHostStatus(member.hostId, display);

  const remote = isRemoteHost(member.hostId);
  const hostSection = remote ? `host-${member.hostId}` : LOCAL_HOST_SECTION;

  return (
    <HostRowShell
      sectionId={`project-host-${member.id}`}
      testId="project-host-row"
      hostId={member.hostId}
      defaultOpen={defaultOpen}
      icon={
        remote ? (
          <HostStateIcon display={display ?? pendingDisplay(member.hostId)} size={15} />
        ) : (
          <Laptop size={15} aria-hidden />
        )
      }
      tone={tone}
      name={name}
      status={word}
      detail={<span title={member.path}>{member.path}</span>}
      footer={
        <>
          <Button variant="link" onClick={() => goTo({ type: "hosts" }, hostSection)}>
            Open {name} in Hosts
          </Button>
          <span className={hostStyles.spacer} />
          {memberCount > 1 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => openRemoveFromHost(member.id)}
            >
              Remove from {name}
            </Button>
          )}
        </>
      }
    >
      <Stack gap="xs">
        <label className={styles.fieldLabel}>Default Branch</label>
        <div className={styles.fieldStatic}>{member.defaultBranch}</div>
      </Stack>
      <WorktreeFields member={member} />
      <PreviewUrlsField member={member} />
      <MissingRepoRepair member={member} />
    </HostRowShell>
  );
}
