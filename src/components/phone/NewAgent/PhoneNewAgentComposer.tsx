import ArrowUp from "lucide-react/dist/esm/icons/arrow-up";
import Check from "lucide-react/dist/esm/icons/check";
import Cloud from "lucide-react/dist/esm/icons/cloud";
import Folder from "lucide-react/dist/esm/icons/folder";
import GitBranch from "lucide-react/dist/esm/icons/git-branch";
import Laptop from "lucide-react/dist/esm/icons/laptop";
import X from "lucide-react/dist/esm/icons/x";
import { useMemo, useState, type CSSProperties, type ReactNode, type SyntheticEvent } from "react";
import type { AgentInfo } from "../../../electron.d";
import { useAgentDisplay } from "../../../hooks/useAgentDisplay";
import { useHostDisplay } from "../../../hooks/useHostDisplay";
import { resumeAgent } from "../../../lib/agent-resume";
import { greeting } from "../../../lib/greeting";
import { isRemoteHost, memberHostName } from "../../../lib/hosts";
import { workspaceHostChoices } from "../../../lib/workspace-host-choices";
import type { WorkspaceKey } from "../../../lib/workspace-key";
import { useAgentStore } from "../../../store/agent-store";
import { selectActiveWorkspaceKey, useAppStore } from "../../../store/app-store";
import { useHostStore, type HostStatusInfo } from "../../../store/host-store";
import { useProjectStore, type ProjectInfo } from "../../../store/project-store";
import { relativeShortThenDate } from "../../../utils/relative-time";
import { HostStateIcon } from "../../hosts/HostStateIcon";
import { Button } from "../../ui/Button/Button";
import { Checkbox } from "../../ui/Checkbox/Checkbox";
import { EmojiTextarea } from "../../ui/EmojiAutocomplete";
import { ManorLogo } from "../../ui/ManorLogo";
import chatStyles from "../ChatPane/ChatPane.module.css";
import { recentStatus, recentWorkspaceAgents } from "../phone-empty-state";
import { useViewerFirstName } from "../useViewerFirstName";
import {
  baseBranchOf,
  projectChoices,
  resolveTarget,
  seedTarget,
  selectHost,
  selectProject,
  workspaceChoices,
  type NewAgentTarget,
  type ResolvedTarget,
} from "./new-agent-target";
import styles from "./PhoneNewAgentComposer.module.css";
import { sendNewAgent } from "./send-new-agent";

type PhoneNewAgentComposerProps = {
  /** Opened as the "New agent" surface: shows × to go back to the workspace. */
  closable: boolean;
};

type ChoiceKind = "host" | "project" | "workspace";

/** Chips and rows act on click; cancelling the press keeps focus (and the soft keyboard) in the textarea. */
function keepFocus(e: SyntheticEvent) {
  e.preventDefault();
}

/**
 * The target the composer shows, resolved: `picked` while it still resolves,
 * else the active workspace (`seedTarget`). Null with no projects.
 */
function shownTarget(
  picked: NewAgentTarget | null,
  projects: readonly ProjectInfo[],
  activeKey: WorkspaceKey | null,
  hosts: readonly HostStatusInfo[],
): { target: NewAgentTarget; resolved: ResolvedTarget<ProjectInfo> } | null {
  for (const target of [picked, seedTarget(projects, activeKey, hosts)]) {
    const resolved = target && resolveTarget(target, projects);
    if (target && resolved) return { target, resolved };
  }
  return null;
}

/**
 * The phone's new-agent composer (ADR-222 D5): a chat that hasn't started
 * yet, whose first message is the agent's prompt. Chips above the field pick
 * where it runs (host, project, workspace, or a new worktree off it), the
 * greeting and the recents rail follow that choice, and nothing launches
 * until the message is sent.
 *
 * Shown as the "New agent" surface (`closable`) and as an empty workspace.
 */
export function PhoneNewAgentComposer(props: PhoneNewAgentComposerProps) {
  const { closable } = props;

  const projects = useProjectStore((s) => s.projects);
  const hosts = useHostStore((s) => s.hosts);
  const activeKey = useAppStore(selectActiveWorkspaceKey);
  const draft = useAppStore((s) => s.composerDraft);
  const setComposerDraft = useAppStore((s) => s.setComposerDraft);
  const closeComposer = useAppStore((s) => s.closeComposer);

  // Which target the composer shows: the one the user picked, until then (or
  // once it went stale) the active workspace. The "New agent" surface keeps
  // its pick in the draft, across close and reopen. The empty-workspace
  // screen belongs to one workspace (its wrapper remounts it per workspace),
  // so its pick is its own.
  const [localPick, setLocalPick] = useState<NewAgentTarget | null>(null);
  const picked = closable ? draft.target : localPick;
  const setPicked = (next: NewAgentTarget) => {
    if (closable) setComposerDraft({ target: next });
    else setLocalPick(next);
  };
  const shown = shownTarget(picked, projects, activeKey, hosts);

  const [open, setOpen] = useState<ChoiceKind | null>(null);

  const pick = (next: NewAgentTarget) => {
    setPicked(next);
    setOpen(null);
  };

  const canSend = draft.text.trim().length > 0 && shown !== null;
  const submit = () => {
    if (canSend) sendNewAgent(draft.text, shown.target);
  };

  return (
    <div className={styles.root} data-testid="phone-empty-workspace">
      {closable && (
        <Button
          variant="ghost"
          size="sm"
          className={styles.close}
          aria-label="Close"
          onClick={closeComposer}
          data-testid="phone-composer-close"
        >
          <X size={18} />
        </Button>
      )}
      <div className={styles.body}>
        <div className={styles.mark}>
          <div className={styles.glow} aria-hidden="true" />
          <div className={styles.logo}>
            <ManorLogo />
          </div>
        </div>
        <Greeting resolved={shown?.resolved ?? null} newWorktree={shown?.target.newWorktree ?? false} />
      </div>
      {shown && <RecentAgents workspacePath={shown.resolved.workspace.path} hostId={shown.resolved.hostId} />}
      <div
        className={chatStyles.composer}
        data-keyboard-lift
        onKeyDown={(e) => {
          if (e.key === "Escape" && open) {
            e.preventDefault();
            setOpen(null);
          }
        }}
      >
        {shown && open && (
          <TargetChoices
            kind={open}
            target={shown.target}
            resolved={shown.resolved}
            onPick={pick}
            onDismiss={() => setOpen(null)}
          />
        )}
        {shown && (
          <TargetChips
            target={shown.target}
            resolved={shown.resolved}
            onOpen={(kind) => setOpen((current) => (current === kind ? null : kind))}
            onToggleWorktree={() => setPicked({ ...shown.target, newWorktree: !shown.target.newWorktree })}
          />
        )}
        <div className={chatStyles.composerField}>
          <EmojiTextarea
            className={chatStyles.composerInput}
            value={draft.text}
            rows={1}
            placeholder="Ask Claude…"
            aria-label="First message for a new agent"
            data-testid="phone-empty-composer-input"
            onChange={(e) => setComposerDraft({ text: e.target.value })}
            onKeyDown={(e) => {
              // As in the chat: ⌘/Ctrl+Enter sends, a plain Enter is a new line.
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <Button
            variant="primary"
            className={chatStyles.composerButton}
            aria-label="Start agent"
            disabled={!canSend}
            onClick={submit}
            data-testid="phone-empty-send"
          >
            <ArrowUp size={16} strokeWidth={2.5} />
          </Button>
        </div>
      </div>
    </div>
  );
}

/** "Good evening" and where the new agent will run. */
function Greeting(props: { resolved: ResolvedTarget<ProjectInfo> | null; newWorktree: boolean }) {
  const { resolved, newWorktree } = props;

  // Read once per mount: the screen is short-lived, and a greeting that
  // flips mid-read is worse than one an hour stale.
  const [hello] = useState(() => greeting(Date.now()));
  const firstName = useViewerFirstName();

  return (
    <div className={styles.greeting}>
      <h1 className={styles.headline}>{firstName ? `${hello}, ${firstName}` : hello}</h1>
      <p className={styles.subline} data-testid="phone-composer-subline">
        {resolved ? <TargetSentence resolved={resolved} newWorktree={newWorktree} /> : "Add a project to start an agent."}
      </p>
    </div>
  );
}

function TargetSentence(props: { resolved: ResolvedTarget<ProjectInfo>; newWorktree: boolean }) {
  const { resolved, newWorktree } = props;

  const { project, workspace } = resolved;
  const branch = workspace.branch;
  if (newWorktree) {
    const base = baseBranchOf(resolved);
    return (
      <>
        Claude will start a new worktree off{" "}
        {base ? <span className={styles.branch}>{base}</span> : "the default branch"}. What's on your mind?
      </>
    );
  }
  // Main is named for its project ("homebook on main"); a workspace for itself.
  const name = workspace.isMain ? project.name : workspace.label || branch;
  return (
    <>
      Claude is ready in <span className={styles.workspaceName}>{name}</span>
      {branch && branch !== name ? (
        <>
          {" "}on <span className={styles.branch}>{branch}</span>
        </>
      ) : null}
      . What's on your mind?
    </>
  );
}

/** This machine's laptop, or a remote host's cloud in its current state. */
function HostGlyph(props: { hostId: string }) {
  const { hostId } = props;

  const display = useHostDisplay(hostId);
  if (!isRemoteHost(hostId)) return <Laptop size={14} aria-hidden />;
  return display ? <HostStateIcon display={display} size={14} /> : <Cloud size={14} aria-hidden />;
}

type TargetChipsProps = {
  target: NewAgentTarget;
  resolved: ResolvedTarget<ProjectInfo>;
  onOpen: (kind: ChoiceKind) => void;
  onToggleWorktree: () => void;
};

/** `[host] [📁 project] [⑂ workspace │ ☐ worktree]`, scrolling sideways. */
function TargetChips(props: TargetChipsProps) {
  const { target, resolved, onOpen, onToggleWorktree } = props;

  const projects = useProjectStore((s) => s.projects);
  const hosts = useHostStore((s) => s.hosts);
  const { project, workspace } = resolved;
  const showHost = workspaceHostChoices(project, projects, hosts) !== null;
  const hostName = memberHostName(project.hostId, hosts);
  const projectName = project.group?.name ?? project.name;

  return (
    <div className={styles.chips} data-testid="phone-target-chips">
      {showHost && (
        <Button
          variant="ghost"
          className={styles.chip}
          onPointerDown={keepFocus}
          onMouseDown={keepFocus}
          onClick={() => onOpen("host")}
          aria-label={`Host: ${hostName}`}
          data-testid="phone-target-host"
        >
          <HostGlyph hostId={project.hostId} />
          <span className={styles.chipLabel}>{hostName}</span>
        </Button>
      )}
      <Button
        variant="ghost"
        className={styles.chip}
        onPointerDown={keepFocus}
        onMouseDown={keepFocus}
        onClick={() => onOpen("project")}
        aria-label={`Project: ${projectName}`}
        data-testid="phone-target-project"
      >
        <Folder size={14} aria-hidden />
        <span className={styles.chipLabel}>{projectName}</span>
      </Button>
      <span className={styles.chipGroup}>
        <Button
          variant="ghost"
          className={`${styles.chip} ${styles.chipPart}`}
          onPointerDown={keepFocus}
          onMouseDown={keepFocus}
          onClick={() => onOpen("workspace")}
          aria-label={`Workspace: ${workspace.label || workspace.branch}`}
          data-testid="phone-target-workspace"
        >
          <GitBranch size={14} aria-hidden />
          <span className={styles.chipLabel}>{workspace.label || workspace.branch}</span>
        </Button>
        <span className={styles.divider} aria-hidden />
        <label className={styles.worktree} onPointerDown={keepFocus} onMouseDown={keepFocus}>
          <Checkbox
            size="md"
            checked={target.newWorktree}
            onCheckedChange={onToggleWorktree}
            data-testid="phone-target-worktree"
          />
          worktree
        </label>
      </span>
    </div>
  );
}

type ChoiceRow = {
  key: string;
  label: string;
  description?: string | null;
  leading?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  next: NewAgentTarget;
};

type TargetChoicesProps = {
  kind: ChoiceKind;
  target: NewAgentTarget;
  resolved: ResolvedTarget<ProjectInfo>;
  onPick: (next: NewAgentTarget) => void;
  onDismiss: () => void;
};

const CHOICE_HEADINGS: Record<ChoiceKind, string> = {
  host: "Run on",
  project: "Project",
  workspace: "Workspace",
};

function colorDotStyle(color: string | null): CSSProperties | undefined {
  return color ? { background: `var(--${color})` } : undefined;
}

/** The rows of `kind`'s choice list, each with the target picking it leads to. */
function choiceRows(
  kind: ChoiceKind,
  target: NewAgentTarget,
  resolved: ResolvedTarget<ProjectInfo>,
  projects: readonly ProjectInfo[],
  hosts: readonly HostStatusInfo[],
): ChoiceRow[] {
  if (kind === "host") {
    return (workspaceHostChoices(resolved.project, projects, hosts) ?? []).map((choice) => ({
      key: choice.projectId,
      label: memberHostName(choice.hostId, hosts),
      description: choice.disabledReason,
      leading: <HostGlyph hostId={choice.hostId} />,
      checked: choice.projectId === target.projectId,
      disabled: choice.disabledReason !== null,
      next: selectHost(target, choice.projectId, projects),
    }));
  }
  if (kind === "project") {
    const groupId = resolved.project.group?.id;
    return projectChoices(projects).map((choice) => ({
      key: choice.id,
      label: choice.name,
      leading: <span className={styles.dot} style={colorDotStyle(choice.color)} aria-hidden />,
      checked: choice.isGroup ? choice.id === groupId : choice.id === target.projectId,
      next: selectProject(target, choice.id, projects, hosts),
    }));
  }
  return workspaceChoices(target, projects).map((choice) => ({
    key: choice.path,
    label: choice.label || choice.branch,
    description: choice.label && choice.branch && choice.branch !== choice.label ? choice.branch : null,
    checked: choice.path === target.workspacePath,
    next: { ...target, workspacePath: choice.path },
  }));
}

/**
 * A chip's choices, drawn above the composer like `CommandChoiceSheet`: focus
 * stays in the textarea, and a tap outside (or Escape) dismisses it.
 */
function TargetChoices(props: TargetChoicesProps) {
  const { kind, target, resolved, onPick, onDismiss } = props;

  const projects = useProjectStore((s) => s.projects);
  const hosts = useHostStore((s) => s.hosts);

  const rows = choiceRows(kind, target, resolved, projects, hosts);

  return (
    <>
      <div className={chatStyles.choiceBackdrop} onPointerDown={onDismiss} aria-hidden />
      <div className={chatStyles.slashMenu} data-testid="phone-target-choices">
        <div className={`${chatStyles.choiceHeader} ${styles.choiceHeader}`}>{CHOICE_HEADINGS[kind]}</div>
        <div className={chatStyles.slashMenuList} role="listbox" aria-label={CHOICE_HEADINGS[kind]}>
          {rows.map((row) => (
            <Button
              key={row.key}
              variant="ghost"
              role="option"
              aria-selected={row.checked}
              tabIndex={-1}
              disabled={row.disabled}
              className={`${chatStyles.slashItem} ${row.checked ? chatStyles.slashItemSelected : ""}`}
              data-testid="phone-target-choice"
              onPointerDown={keepFocus}
              onMouseDown={keepFocus}
              onClick={() => onPick(row.next)}
            >
              <span className={chatStyles.slashItemHead}>
                {row.leading}
                <span className={`${chatStyles.choiceLabel} ${styles.choiceLabel}`}>{row.label}</span>
                {row.checked && <Check size={14} className={styles.check} aria-hidden />}
              </span>
              {row.description && (
                <span className={`${chatStyles.slashItemDescription} ${styles.choiceDescription}`}>
                  {row.description}
                </span>
              )}
            </Button>
          ))}
        </div>
      </div>
    </>
  );
}

/** The target workspace's past agents, newest first, as a sideways-scrolling rail. */
function RecentAgents(props: { workspacePath: string; hostId: string }) {
  const { workspacePath, hostId } = props;

  const agents = useAgentStore((s) => s.agents);
  const recents = useMemo(
    () => recentWorkspaceAgents(agents, workspacePath, hostId),
    [agents, workspacePath, hostId],
  );

  if (recents.length === 0) return null;

  return (
    <section className={styles.recents} aria-labelledby="phone-recents-heading">
      <h2 id="phone-recents-heading" className={styles.recentsHeading}>
        Jump back in
      </h2>
      <div className={styles.rail} data-testid="phone-recent-agents">
        {recents.map((agent) => (
          <RecentAgentCard key={agent.id} agent={agent} />
        ))}
      </div>
    </section>
  );
}

function RecentAgentCard(props: { agent: AgentInfo }) {
  const { agent } = props;

  const { title } = useAgentDisplay(agent);
  const { label, tone } = recentStatus(agent);
  const when = relativeShortThenDate(Date.parse(agent.updatedAt));

  return (
    <Button
      variant="ghost"
      className={styles.card}
      data-tone={tone}
      onClick={() => resumeAgent(agent)}
      data-testid="phone-recent-agent"
    >
      <span className={styles.cardTitle}>{title}</span>
      <span className={styles.cardStatus}>
        <span className={styles.cardDot} aria-hidden="true" />
        {label} · {when}
      </span>
    </Button>
  );
}
