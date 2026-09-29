import type { CSSProperties, ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import GitBranch from "lucide-react/dist/esm/icons/git-branch";
import GitPullRequest from "lucide-react/dist/esm/icons/git-pull-request";
import CircleDot from "lucide-react/dist/esm/icons/circle-dot";
import Radio from "lucide-react/dist/esm/icons/radio";
import { useProjectStore } from "../../../store/project-store";
import { useAppStore } from "../../../store/app-store";
import { useAgentStore } from "../../../store/agent-store";
import { usePortsStore } from "../../../store/ports-store";
import { blockedReason } from "../../../lib/home-dashboard";
import {
  prStage,
  type WorkspaceTileState,
} from "../../../lib/home-dashboard-studio";
import { STATUS_COLOR, STATUS_LABEL } from "./timeline-model";
import { WORKSPACE_STATE_COLOR, WORKSPACE_STATE_LABEL } from "./workspace-state";
import { useHoverOpen } from "./useHoverOpen";
import { PR_STAGE } from "./pr-stage";
import styles from "./WorkspacePopover.module.css";

type WorkspacePopoverProps = {
  projectId: string;
  path: string;
  state: WorkspaceTileState;
  /** The workspace block this popover describes. */
  children: ReactNode;
};

/**
 * The hover card behind a project tile's workspace block (ADR-198): what the
 * block's colour summarises, spelled out — branch, agents and their status,
 * the PR and where it stands, diff, dev server and linked issues. Read-only;
 * clicking the block itself opens the workspace.
 */
export function WorkspacePopover(props: WorkspacePopoverProps) {
  const { projectId, path, state, children } = props;
  const { open, setOpen, onEnter, onLeave } = useHoverOpen();

  const workspace = useProjectStore((s) =>
    s.projects
      .find((p) => p.id === projectId)
      ?.workspaces.find((w) => w.path === path),
  );
  const allAgents = useAgentStore((s) => s.agents);
  const paneAgentStatus = useAppStore((s) => s.paneAgentStatus);
  const ports = usePortsStore((s) => s.ports);

  if (!workspace) return <>{children}</>;

  const agents = allAgents.filter(
    (a) =>
      a.workspacePath === path && a.status !== "completed" && a.paneId != null,
  );
  const wsPorts = ports.filter((p) => p.workspacePath === path);
  const pr = workspace.pr?.state === "open" ? workspace.pr : null;
  const stage = pr ? prStage(pr) : null;
  const diff = workspace.diffStats;
  const name = workspace.name || workspace.branch || path.split("/").pop();

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Anchor asChild>
        <span
          className={styles.anchor}
          onMouseEnter={onEnter}
          onMouseLeave={onLeave}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
        >
          {children}
        </span>
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          className={styles.popover}
          side="top"
          sideOffset={8}
          collisionPadding={8}
          onMouseEnter={onEnter}
          onMouseLeave={onLeave}
          // Portal content still bubbles React events to the tile, whose own
          // click opens its most urgent workspace.
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          style={{ "--c": WORKSPACE_STATE_COLOR[state] } as CSSProperties}
        >
          <div className={styles.head}>
            <span className={styles.name}>{name}</span>
            <span className={styles.state}>{WORKSPACE_STATE_LABEL[state]}</span>
          </div>
          {workspace.branch && (
            <div className={styles.branch}>
              <GitBranch size={12} />
              <span>{workspace.branch}</span>
              {diff && (diff.added > 0 || diff.removed > 0) && (
                <span className={styles.diff}>
                  <span className={styles.added}>+{diff.added}</span>
                  <span className={styles.removed}>−{diff.removed}</span>
                </span>
              )}
            </div>
          )}

          {agents.length > 0 && (
            <section className={styles.section}>
              {agents.map((agent) => {
                const status = paneAgentStatus[agent.paneId!]?.status ?? "idle";
                return (
                  <div key={agent.id} className={styles.row}>
                    <i
                      className={styles.dot}
                      style={{ background: STATUS_COLOR[status] }}
                    />
                    <span className={styles.rowMain}>
                      {agent.name || "Agent"}
                    </span>
                    <span
                      className={styles.rowMeta}
                      style={{ color: STATUS_COLOR[status] }}
                    >
                      {STATUS_LABEL[status]}
                    </span>
                  </div>
                );
              })}
            </section>
          )}

          {pr && stage && (
            <section className={styles.section}>
              <div className={styles.row}>
                <GitPullRequest size={12} className={styles.icon} />
                <span className={styles.rowMain}>
                  <span className={styles.mono}>#{pr.number}</span> {pr.title}
                </span>
              </div>
              <div className={styles.sub}>
                {stage === "blocked"
                  ? blockedReason(pr)
                  : PR_STAGE[stage].label}
                {pr.checks && pr.checks.total > 0 && (
                  <>
                    {" · "}
                    {pr.checks.passing}/{pr.checks.total} checks
                  </>
                )}
              </div>
            </section>
          )}

          {(wsPorts.length > 0 ||
            (workspace.linkedIssues?.length ?? 0) > 0) && (
            <section className={styles.section}>
              {wsPorts.map((port) => (
                <div key={`${port.hostId}:${port.port}`} className={styles.row}>
                  <Radio size={12} className={styles.icon} />
                  <span className={`${styles.rowMain} ${styles.port}`}>
                    :{port.port}
                  </span>
                  <span className={styles.rowMeta}>{port.processName}</span>
                </div>
              ))}
              {workspace.linkedIssues?.map((issue) => (
                <div key={issue.id} className={styles.row}>
                  <CircleDot size={12} className={styles.icon} />
                  <span className={styles.rowMain}>
                    <span className={styles.mono}>{issue.identifier}</span>{" "}
                    {issue.title}
                  </span>
                </div>
              ))}
            </section>
          )}

          {agents.length === 0 && !pr && wsPorts.length === 0 && (
            <div className={styles.sub}>No agents, PR or dev server.</div>
          )}
          <div className={styles.hint}>Click to open workspace</div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
