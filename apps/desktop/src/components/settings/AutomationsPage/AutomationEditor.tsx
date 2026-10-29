import { useRef, useState } from "react";
import Play from "lucide-react/dist/esm/icons/play";
import TriangleAlert from "lucide-react/dist/esm/icons/triangle-alert";
import {
  DEFAULT_MISSED_GRACE_MINUTES,
  MAX_KEEP_LAST,
  validateAutomationInput,
  type AutomationAgentKind,
  type AutomationInput,
  type AutomationWorkspace,
} from "../../../lib/automations";
import type { AutomationDetail, AutomationView } from "../../../lib/automation-views";
import { nextOccurrences, timezoneLabel } from "../../../lib/cron-describe";
import { useMountEffect } from "../../../hooks/useMountEffect";
import { workspaceKey } from "../../../lib/workspace-key";
import { useProjectStore, type ProjectInfo } from "../../../store/project-store";
import { Button } from "../../ui/Button/Button";
import { ConfirmDialog } from "../../ui/ConfirmDialog/ConfirmDialog";
import { Input, Textarea } from "../../ui/Input";
import { Switch } from "../../ui/Switch/Switch";
import { SectionTitle } from "../SectionTitle";
import {
  AGENT_KIND_LABEL,
  AGENT_KINDS,
  dayAndTime,
  isProjectMissing,
  scheduleNote,
  workspaceChipText,
  zoneNote,
} from "./automation-text";
import { ChipMenu, MenuDivider, MenuItem, StaticChip } from "./ChipMenu";
import { RunHistory } from "./RunHistory";
import { ScheduleMenu } from "./ScheduleMenu";
import {
  draftOf,
  inputOf,
  KEEP_ALL,
  parseKeepLast,
  projectsOn,
  storedWorkspace,
  type Draft,
} from "./draft";
import { errorText, useAutomationDetail, type AutomationHost } from "./useAutomations";
import styles from "./AutomationsPage.module.css";

/** How long typing in the name or prompt settles before it is saved. */
const TYPING_SAVE_MS = 600;

/** A workspace's key, as automations name it; its bare path if it has none. */
function keyOf(hostId: string, path: string): string {
  try {
    return workspaceKey(hostId, path);
  } catch {
    return path;
  }
}

/**
 * A workspace by the path an automation names it with — its workspace key,
 * `<hostId>:/path` on a remote host — named as the sidebar names it.
 */
function workspaceNamer(projects: readonly ProjectInfo[]) {
  return (key: string): string | null => {
    for (const project of projects) {
      const ws = project.workspaces.find((w) => keyOf(project.hostId, w.path) === key);
      if (ws) return ws.name ?? ws.branch;
    }
    return null;
  };
}

type Shared = {
  hosts: AutomationHost[];
  onBack: () => void;
  onOpenAgent: (agentId: string) => void;
};

/** One automation's page, read from its host and kept current. */
export function ExistingAutomation(
  props: Shared & {
    hostId: string;
    id: string;
    /** Called instead of showing "deleted" when it can't be read: a link to it is stale. */
    onMissing?: () => void;
  },
) {
  const { hostId, id, hosts, onBack, onMissing } = props;
  const { detail, setDetail, reload } = useAutomationDetail(hostId, id, onMissing);
  const host = hosts.find((h) => h.hostId === hostId);

  if (detail === null || detail === "missing" || !host) {
    return (
      <div className={styles.detail} data-testid="automation-detail">
        <BackLink onBack={onBack} />
        <div className={styles.placeholder}>
          {detail === "missing" ? "This automation was deleted." : "Loading…"}
        </div>
      </div>
    );
  }
  return (
    <AutomationForm
      {...props}
      host={host}
      detail={detail}
      onSaved={(view) => setDetail({ ...detail, ...view })}
      onReload={reload}
    />
  );
}

/** A new automation's page: the same as an existing one's, saved by Create. */
export function NewAutomation(
  props: Shared & { initial: Draft; onCreated: (hostId: string, id: string) => void },
) {
  const host = props.hosts.find((h) => h.hostId === props.initial.hostId) ?? props.hosts[0];
  return (
    <AutomationForm
      {...props}
      hostId={props.initial.hostId}
      host={host}
      detail={null}
      onSaved={() => {}}
      onReload={() => {}}
    />
  );
}

function BackLink(props: { onBack: () => void }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className={styles.back}
      data-testid="automation-back"
      onClick={props.onBack}
    >
      ‹ Automations
    </Button>
  );
}

type FormProps = Shared & {
  host: AutomationHost;
  hostId: string;
  /** Null while it is new. */
  detail: AutomationDetail | null;
  /** A new automation's draft; an existing one's is its detail's. */
  initial?: Draft;
  onSaved: (view: AutomationView) => void;
  onReload: () => void;
  onCreated?: (hostId: string, id: string) => void;
};

function AutomationForm(props: FormProps) {
  const { hosts, onBack, onOpenAgent, detail, initial, onSaved, onReload, onCreated } = props;
  const isNew = detail === null;
  const projects = useProjectStore((s) => s.projects);
  const [draft, setDraft] = useState<Draft>(() => initial ?? draftOf(detail!, props.hostId));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"run" | "create" | null>(null);
  const [deleting, setDeleting] = useState(false);
  /** A project was picked here: a failed run's "project missing" is answered. */
  const [projectPicked, setProjectPicked] = useState(false);
  const pending = useRef<Partial<AutomationInput>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Saves sent and not yet answered. */
  const inFlight = useRef(0);
  const top = useRef<HTMLDivElement>(null);
  /** The newest draft, for a save that runs after this render (the unmount flush). */
  const latest = useRef(draft);
  latest.current = draft;

  const editing = (): boolean => {
    if (timer.current || inFlight.current > 0 || Object.keys(pending.current).length > 0) return true;
    const focused = document.activeElement;
    return (
      !!focused &&
      !!top.current?.contains(focused) &&
      (focused.tagName === "INPUT" || focused.tagName === "TEXTAREA")
    );
  };

  // A change made elsewhere (a phone, the CLI) is shown, unless it would
  // overwrite what is being edited here: an unsaved change, a save on its
  // way, or a field with focus.
  const [syncedAt, setSyncedAt] = useState(detail?.updatedAt ?? null);
  if (detail && detail.updatedAt !== syncedAt && !editing()) {
    setSyncedAt(detail.updatedAt);
    setDraft(draftOf(detail, draft.hostId));
  }

  const host = hosts.find((h) => h.hostId === draft.hostId) ?? props.host;
  const hostProjects = projectsOn(projects, draft.hostId);
  const project = projects.find((p) => p.id === draft.projectId && p.hostId === draft.hostId);
  const nameWorkspace = workspaceNamer(hostProjects);

  /** Sends what has changed since the last save, if the whole still holds. */
  const flush = (next: Draft) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const patch = pending.current;
    pending.current = {};
    if (isNew || !detail || Object.keys(patch).length === 0) return;
    // A cleared Keep last is sent as `keepLast: null`; the whole is checked as stored.
    const problem = validateAutomationInput(inputOf(next));
    if (problem) {
      setError(problem);
      pending.current = patch;
      return;
    }
    setError(null);
    inFlight.current += 1;
    window.electronAPI.automations.update(next.hostId, detail.id, patch).then(
      (view) => {
        inFlight.current -= 1;
        onSaved(view);
      },
      (err: unknown) => {
        inFlight.current -= 1;
        setError(errorText(err));
      },
    );
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;

  useMountEffect(() => {
    top.current?.scrollIntoView?.({ block: "start" });
    return () => {
      // Closing Settings mid-typing still saves what was typed.
      if (timer.current) flushRef.current(latest.current);
    };
  });

  /** Changes the draft, and saves it: now, or once typing settles. */
  const change = (patch: Partial<AutomationInput>, opts: { typing?: boolean } = {}) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    pending.current = { ...pending.current, ...patch };
    if (isNew) {
      setError(null);
      return;
    }
    if (opts.typing) {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => flush(next), TYPING_SAVE_MS);
    } else {
      flush(next);
    }
  };

  const setEnabled = (enabled: boolean) => {
    setDraft((d) => ({ ...d, enabled }));
    if (isNew || !detail) return;
    inFlight.current += 1;
    window.electronAPI.automations.setEnabled(draft.hostId, detail.id, enabled).then(
      (view) => {
        inFlight.current -= 1;
        onSaved(view);
      },
      (err: unknown) => {
        inFlight.current -= 1;
        setDraft((d) => ({ ...d, enabled: !enabled }));
        setError(errorText(err));
      },
    );
  };

  const runNow = () => {
    if (!detail) return;
    setBusy("run");
    setError(null);
    window.electronAPI.automations
      .runNow(draft.hostId, detail.id)
      .then(
        () => onReload(),
        (err: unknown) => setError(errorText(err)),
      )
      .finally(() => setBusy(null));
  };

  const create = () => {
    const hostId = draft.hostId;
    const input = inputOf(draft);
    const problem = validateAutomationInput(input);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy("create");
    setError(null);
    window.electronAPI.automations.create(hostId, input).then(
      (view) => {
        setBusy(null);
        onCreated?.(hostId, view.id);
      },
      (err: unknown) => {
        setBusy(null);
        setError(errorText(err));
      },
    );
  };

  const remove = async () => {
    if (!detail) return;
    try {
      await window.electronAPI.automations.remove(draft.hostId, detail.id);
    } catch (err) {
      // E.g. a device on a host server, which may not delete.
      setDeleting(false);
      setError(errorText(err));
      return;
    }
    setDeleting(false);
    onBack();
  };

  const setWorkspace = (workspace: AutomationWorkspace) => change({ workspace });

  const next = draft.enabled || isNew
    ? nextOccurrences(draft.schedule.cron, draft.schedule.timezone, 3)
    : [];
  const projectLabel = project?.name ?? (draft.projectId ? "missing project" : "no project");
  // The last run found no project: said until another is picked, or while
  // the one named isn't set up on the host.
  const missing = detail ? isProjectMissing(detail) && (!project || !projectPicked) : false;
  const note = zoneNote(draft.schedule.timezone);

  return (
    <div className={styles.detail} data-testid="automation-detail" ref={top}>
      <div className={styles.detailTop}>
        <BackLink onBack={onBack} />
        <div className={styles.titleRow}>
          <Input
            className={styles.nameInput}
            value={draft.name}
            aria-label="Name"
            data-testid="automation-name"
            onChange={(e) => change({ name: e.target.value }, { typing: true })}
            onBlur={() => flush(draft)}
          />
          <span className={styles.actions}>
            {!isNew && (
              <Button
                variant="secondary"
                size="sm"
                data-testid="automation-run-now"
                disabled={busy === "run"}
                onClick={runNow}
              >
                <Play size={11} aria-hidden className={styles.buttonIcon} />
                {busy === "run" ? "Starting…" : "Run now"}
              </Button>
            )}
            <label className={styles.switchLabel}>
              {isNew ? "Start on" : draft.enabled ? "On" : "Paused"}
              <Switch
                checked={draft.enabled}
                onCheckedChange={setEnabled}
                aria-label={isNew ? "Start on" : draft.enabled ? "Pause" : "Resume"}
                data-testid="automation-enabled"
              />
            </label>
          </span>
        </div>
      </div>

      {missing && (
        <div className={styles.warn} data-testid="automation-project-missing">
          <TriangleAlert size={12} aria-hidden />
          <span>
            {project ? `Project “${project.name}”` : "This automation's project"} isn't set up on{" "}
            {host.name} any more. Pick another project below, or delete this automation.
          </span>
        </div>
      )}

      <div className={styles.card}>
        <SectionTitle id="automation-when">When and where</SectionTitle>
        <div className={styles.sentence}>
          <ScheduleMenu
            cron={draft.schedule.cron}
            timezone={draft.schedule.timezone}
            onChange={(cron, timezone) => change({ schedule: { cron, timezone } })}
          />{" "}
          {timezoneLabel(draft.schedule.timezone)} time, start{" "}
          <ChipMenu kind="agent" label={AGENT_KIND_LABEL[draft.agentKind]} title="Agent">
            {(close) =>
              AGENT_KINDS.map((kind: AutomationAgentKind) => (
                <MenuItem
                  key={kind}
                  selected={draft.agentKind === kind}
                  testId={`automation-agent-${kind}`}
                  onSelect={() => {
                    close();
                    if (kind !== draft.agentKind) change({ agentKind: kind });
                  }}
                >
                  {AGENT_KIND_LABEL[kind]}
                </MenuItem>
              ))
            }
          </ChipMenu>{" "}
          in{" "}
          <ChipMenu kind="project" label={projectLabel} title="Project">
            {(close) =>
              hostProjects.length === 0 ? (
                <div className={styles.menuHint}>No projects are set up on {host.name}.</div>
              ) : (
                hostProjects.map((p) => (
                  <MenuItem
                    key={p.id}
                    selected={p.id === draft.projectId}
                    testId={`automation-project-${p.id}`}
                    onSelect={() => {
                      close();
                      if (p.id === draft.projectId) return;
                      setProjectPicked(true);
                      // A reused workspace is the old project's.
                      change({
                        projectId: p.id,
                        ...(draft.workspace.mode === "reuse" ? { workspace: { mode: "new" } } : {}),
                      });
                    }}
                  >
                    {p.name}
                  </MenuItem>
                ))
              )
            }
          </ChipMenu>{" "}
          on{" "}
          {isNew ? (
            <ChipMenu kind="host" label={host.name} title="Host">
              {(close) =>
                hosts.map((h) => (
                  <MenuItem
                    key={h.hostId}
                    selected={h.hostId === draft.hostId}
                    testId={`automation-host-${h.hostId}`}
                    hint={h.local ? "only while open" : undefined}
                    onSelect={() => {
                      close();
                      if (h.hostId === draft.hostId) return;
                      setDraft({
                        ...draft,
                        hostId: h.hostId,
                        projectId: projectsOn(projects, h.hostId)[0]?.id ?? "",
                        workspace: { mode: "new" },
                      });
                    }}
                  >
                    {h.name}
                  </MenuItem>
                ))
              }
            </ChipMenu>
          ) : (
            <StaticChip kind="host" label={host.name} title="An automation stays on the host it was made on" />
          )}{" "}
          with{" "}
          <ChipMenu kind="workspace" label={workspaceChipText(draft.workspace, nameWorkspace)} title="Workspace">
            {(close) => (
              <WorkspaceOptions
                workspace={draft.workspace}
                project={project ?? null}
                onChange={(ws, done) => {
                  if (done) close();
                  setWorkspace(ws);
                }}
              />
            )}
          </ChipMenu>
        </div>
        <div className={`${styles.note} ${styles.mono}`} data-testid="automation-next-runs">
          {draft.schedule.cron} ·{" "}
          {next.length > 0
            ? `next ${next.map((d) => dayAndTime(d, draft.schedule.timezone)).join(" · ")}${note ? ` ${note}` : ""}`
            : "— paused"}
        </div>
        <div className={styles.note}>
          {scheduleNote(
            host.local,
            host.name,
            draft.missedGraceMinutes ?? DEFAULT_MISSED_GRACE_MINUTES,
          )}
        </div>
      </div>

      <div className={styles.field}>
        <SectionTitle id="automation-prompt">Prompt</SectionTitle>
        <Textarea
          className={styles.prompt}
          value={draft.prompt}
          placeholder="What should the agent do each time?"
          aria-label="Prompt"
          data-testid="automation-prompt"
          onChange={(e) => change({ prompt: e.target.value }, { typing: true })}
          onBlur={() => flush(draft)}
        />
      </div>

      {error && (
        <div className={styles.error} role="alert" data-testid="automation-error">
          {error}
        </div>
      )}

      <div className={styles.field}>
        <SectionTitle id="automation-runs">Runs</SectionTitle>
        {detail && detail.runs.length > 0 ? (
          <RunHistory
            runs={detail.runs}
            local={host.local}
            workspaceName={nameWorkspace}
            onOpenAgent={onOpenAgent}
          />
        ) : (
          <div className={styles.placeholder}>
            {isNew
              ? "No runs yet. Create it paused, then use Run now to try it."
              : "No runs yet. Use Run now to try it."}
          </div>
        )}
      </div>

      <div className={styles.footer}>
        {isNew ? (
          <span className={styles.footerButtons}>
            <Button variant="secondary" size="sm" data-testid="automation-cancel" onClick={onBack}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              data-testid="automation-create"
              disabled={busy === "create"}
              onClick={create}
            >
              Create
            </Button>
          </span>
        ) : (
          <>
            <Button
              variant="ghost"
              size="sm"
              className={styles.deleteButton}
              data-testid="automation-delete"
              onClick={() => setDeleting(true)}
            >
              Delete automation
            </Button>
            <span className={styles.note}>Changes save as you make them</span>
            <ConfirmDialog
              open={deleting}
              title={`Delete ${draft.name}?`}
              description="It stops running. Its run history goes with it; the workspaces its runs made stay."
              confirmLabel="Delete"
              confirmVariant="danger"
              onCancel={() => setDeleting(false)}
              onConfirm={remove}
            />
          </>
        )}
      </div>
    </div>
  );
}

type WorkspaceOptionsProps = {
  workspace: AutomationWorkspace;
  project: ProjectInfo | null;
  /** `done` closes the menu: a pick does, typing a number doesn't. */
  onChange: (workspace: AutomationWorkspace, done: boolean) => void;
};

/** "New workspace" (keeping the last N, optionally), or reuse one of the project's. */
function WorkspaceOptions(props: WorkspaceOptionsProps) {
  const { workspace, project, onChange } = props;
  const stored = storedWorkspace(workspace);
  const keepLast = stored.mode === "new" ? stored.keepLast : undefined;
  const [keepText, setKeepText] = useState(keepLast ? String(keepLast) : "");
  const keepProblem =
    parseKeepLast(keepText) === null ? `Keep 1 to ${MAX_KEEP_LAST}, or leave it empty for all` : null;
  const workspaces = (project?.workspaces ?? []).filter((w) => !w.hidden);

  const applyKeep = () => {
    const next = parseKeepLast(keepText);
    if (next === null || next === keepLast) return;
    onChange(next === undefined ? KEEP_ALL : { mode: "new", keepLast: next }, false);
  };

  return (
    <>
      <MenuItem
        selected={workspace.mode === "new"}
        testId="automation-workspace-new"
        onSelect={() => {
          if (workspace.mode !== "new") onChange({ mode: "new" }, true);
        }}
      >
        New workspace each run
      </MenuItem>
      {workspace.mode === "new" && (
        <div className={styles.menuStack}>
          <label className={styles.menuField}>
            Keep last
            <Input
              type="number"
              min={1}
              max={MAX_KEEP_LAST}
              aria-invalid={keepProblem !== null}
              className={styles.menuNumber}
              value={keepText}
              placeholder="all"
              data-testid="automation-workspace-keep"
              onChange={(e) => setKeepText(e.target.value)}
              onBlur={applyKeep}
              onKeyDown={(e) => {
                if (e.key === "Enter") applyKeep();
              }}
            />
          </label>
          {keepProblem && <span className={styles.menuError}>{keepProblem}</span>}
        </div>
      )}
      {workspaces.length > 0 && <MenuDivider />}
      {workspaces.map((ws) => {
        // Automations name a workspace by its key: `<hostId>:/path` on a remote host.
        const key = project ? keyOf(project.hostId, ws.path) : ws.path;
        return (
          <MenuItem
            key={ws.path}
            selected={workspace.mode === "reuse" && workspace.workspacePath === key}
            testId={`automation-workspace-reuse-${ws.name ?? ws.branch}`}
            onSelect={() => onChange({ mode: "reuse", workspacePath: key }, true)}
          >
            Reuse “{ws.name ?? ws.branch}”
          </MenuItem>
        );
      })}
    </>
  );
}
