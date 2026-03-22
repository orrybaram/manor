import React, {
  useCallback,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import {
  Plus,
  ChevronRight,
  House,
  FolderGit2,
} from "lucide-react";
import type { ProjectInfo, WorkspaceInfo } from "../store/project-store";
import type { AgentStatus } from "../electron.d";
import { useDebouncedAgentStatus } from "./useDebouncedAgentStatus";
import { useAppStore } from "../store/app-store";
import { useWorkspaceAgents, type WorkspaceAgent } from "../hooks/useWorkspaceAgents";
import { AgentDot } from "./AgentDot";
import { NewWorkspaceDialog } from "./NewWorkspaceDialog";
import { PrPopover } from "./PrPopover";
import { RemoveProjectDialog } from "./RemoveProjectDialog";
import { DeleteWorktreeDialog } from "./DeleteWorktreeDialog";
import { useWorkspaceDrag } from "../hooks/useWorkspaceDrag";
import styles from "./Sidebar.module.css";

export function ProjectItem({
  project,
  isSelected,
  collapsed,
  onToggleCollapsed,
  onSelect: _onSelect,
  onRemove,
  onSelectWorkspace,
  onRemoveWorktree,
  onRenameWorkspace,
  onReorderWorkspaces,
  onCreateWorktree,
  onDragStart,
}: {
  project: ProjectInfo;
  isSelected: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onSelect: () => void;
  onRemove: () => void;
  onSelectWorkspace: (index: number) => void;
  onRemoveWorktree: (ws: WorkspaceInfo, deleteBranch: boolean) => void;
  onRenameWorkspace: (ws: WorkspaceInfo, newName: string) => void;
  onReorderWorkspaces: (orderedPaths: string[]) => void;
  onCreateWorktree: (name: string, branch: string) => Promise<string | null>;
  onDragStart?: (e: ReactPointerEvent) => void;
}) {
  const expanded = !collapsed;
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmDeleteWorktree, setConfirmDeleteWorktree] =
    useState<WorkspaceInfo | null>(null);
  const [newWorkspaceOpen, setNewWorkspaceOpen] = useState(false);
  const [deletingPaths, setDeletingPaths] = useState<Set<string>>(new Set());
  const editRef = useRef<HTMLInputElement>(null);

  const { dragIndex, handleDragStart, getTransformStyle, justDragged, itemRefs } =
    useWorkspaceDrag({
      workspaces: project.workspaces,
      onReorderWorkspaces,
      editingPath,
    });

  const startRename = useCallback((ws: WorkspaceInfo) => {
    setEditingPath(ws.path);
    setEditValue(ws.name || ws.branch || "");
    requestAnimationFrame(() => {
      editRef.current?.focus();
      editRef.current?.select();
    });
  }, []);

  const commitRename = useCallback(
    (ws: WorkspaceInfo) => {
      setEditingPath(null);
      onRenameWorkspace(ws, editValue);
    },
    [editValue, onRenameWorkspace],
  );


  return (
    <div className={styles.project}>
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          <div
            className={styles.projectHeader}
            onClick={() => {
              onToggleCollapsed();
            }}
            onPointerDown={onDragStart}
            style={{ touchAction: "none" }}
          >
            <span className={`${styles.projectChevron} ${expanded ? styles.projectChevronOpen : ""}`}>
              <ChevronRight size={12} />
            </span>
            <span className={styles.projectName} title={project.path}>
              {project.name}
            </span>
            <button
              className={styles.projectAction}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                setNewWorkspaceOpen(true);
              }}
              title="New Workspace"
            >
              <Plus size={12} />
            </button>
          </div>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className={styles.contextMenu}>
            <ContextMenu.Item
              className={styles.contextMenuItem}
              onSelect={() => setNewWorkspaceOpen(true)}
            >
              New Workspace
            </ContextMenu.Item>
            <ContextMenu.Item
              className={`${styles.contextMenuItem} ${styles.contextMenuItemDanger}`}
              onSelect={() => setConfirmRemove(true)}
            >
              Remove Project
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      {expanded && (
        <div className={styles.workspaces}>
          {project.workspaces.map((ws, idx) => {
            const isEditing = editingPath === ws.path;
            const displayName = ws.isMain
              ? ws.name || "local"
              : ws.name || ws.branch || "main";
            const isDragging = dragIndex === idx;
            const isDeleting = deletingPaths.has(ws.path);

            const workspaceEl = (
              <div
                key={ws.path}
                ref={(el) => {
                  if (el) itemRefs.current.set(idx, el);
                  else itemRefs.current.delete(idx);
                }}
                className={`${styles.workspace} ${
                  isSelected && idx === project.selectedWorkspaceIndex
                    ? styles.workspaceActive
                    : ""
                } ${isDragging ? styles.workspaceDragging : ""} ${isDeleting ? styles.workspaceDeleting : ""}`}
                style={getTransformStyle(idx)}
                onClick={() => {
                  if (!justDragged.current) onSelectWorkspace(idx);
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  startRename(ws);
                }}
                onPointerDown={(e) => handleDragStart(idx, e)}
              >
                {isEditing ? (
                  <input
                    ref={editRef}
                    className={styles.workspaceNameInput}
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onBlur={() => {
                      if (editingPath) commitRename(ws);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename(ws);
                      if (e.key === "Escape") {
                        setEditingPath(null);
                        e.currentTarget.blur();
                      }
                    }}
                    onClick={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                  />
                ) : (
                  <>
                    <span className={styles.workspaceIcon}>
                      {ws.isMain ? (
                        <House size={12} />
                      ) : (
                        <FolderGit2 size={12} />
                      )}
                    </span>
                    <div className={styles.workspaceLabel}>
                      <div className={styles.workspaceNameRow}>
                        <span className={styles.workspaceName}>
                          {displayName}
                        </span>
                        {ws.diffStats && (ws.diffStats.added > 0 || ws.diffStats.removed > 0) && (
                          <span className={styles.diffStats}>
                            {ws.diffStats.added > 0 && (
                              <span className={styles.diffAdded}>+{ws.diffStats.added}</span>
                            )}
                            {ws.diffStats.removed > 0 && (
                              <span className={styles.diffRemoved}>-{ws.diffStats.removed}</span>
                            )}
                          </span>
                        )}
                      </div>
                      <div className={styles.workspaceBranchRow}>
                        <span className={styles.workspaceBranch}>
                          {ws.branch || "main"}
                        </span>
                        {ws.pr && (
                          <PrPopover
                            pr={ws.pr}
                            onOpen={() =>
                              window.electronAPI.shell.openExternal(ws.pr!.url)
                            }
                          />
                        )}
                      </div>
                    </div>
                  </>
                )}
              </div>
            );

            return (
              <React.Fragment key={ws.path}>
                <ContextMenu.Root>
                  <ContextMenu.Trigger asChild>{workspaceEl}</ContextMenu.Trigger>
                  <ContextMenu.Portal>
                    <ContextMenu.Content className={styles.contextMenu}>
                      <ContextMenu.Item
                        className={styles.contextMenuItem}
                        onSelect={() =>
                          window.electronAPI.shell.openExternal(`file://${ws.path}`)
                        }
                      >
                        Open in Finder
                      </ContextMenu.Item>
                      <ContextMenu.Item
                        className={styles.contextMenuItem}
                        onSelect={() =>
                          navigator.clipboard.writeText(ws.branch || "main")
                        }
                      >
                        Copy Branch Name
                      </ContextMenu.Item>
                      <ContextMenu.Item
                        className={styles.contextMenuItem}
                        onSelect={() => navigator.clipboard.writeText(ws.path)}
                      >
                        Copy Path
                      </ContextMenu.Item>
                      {!ws.isMain && (
                        <>
                          <ContextMenu.Separator
                            className={styles.contextMenuSeparator}
                          />
                          <ContextMenu.Item
                            className={styles.contextMenuItem}
                            onSelect={() => startRename(ws)}
                          >
                            Rename Workspace
                          </ContextMenu.Item>
                          <ContextMenu.Item
                            className={`${styles.contextMenuItem} ${styles.contextMenuItemDanger}`}
                            onSelect={() => {
                              setConfirmDeleteWorktree(ws);
                            }}
                          >
                            Delete Workspace
                          </ContextMenu.Item>
                        </>
                      )}
                    </ContextMenu.Content>
                  </ContextMenu.Portal>
                </ContextMenu.Root>
                <WorkspaceAgentList
                  workspacePath={ws.path}
                  onNavigate={(agent) => {
                    onSelectWorkspace(idx);
                    const store = useAppStore.getState();
                    store.selectSession(agent.sessionId);
                    store.focusPane(agent.paneId);
                  }}
                />
              </React.Fragment>
            );
          })}
        </div>
      )}

      <NewWorkspaceDialog
        open={newWorkspaceOpen}
        onClose={() => setNewWorkspaceOpen(false)}
        projects={[project]}
        selectedProjectIndex={0}
        onSubmit={async (_projectId, name, branch) => {
          const result = await onCreateWorktree(name, branch);
          if (result) {
            setNewWorkspaceOpen(false);
          }
          return !!result;
        }}
      />

      <RemoveProjectDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        projectName={project.name}
        onConfirm={onRemove}
      />

      <DeleteWorktreeDialog
        open={confirmDeleteWorktree !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmDeleteWorktree(null);
        }}
        workspace={confirmDeleteWorktree}
        onConfirm={(ws, deleteBranch) => {
          setDeletingPaths((prev) => new Set(prev).add(ws.path));
          onRemoveWorktree(ws, deleteBranch);
        }}
      />
    </div>
  );
}

const STATUS_LABEL: Record<string, string> = {
  thinking: "Thinking",
  working: "Working",
  complete: "Done",
  requires_input: "Waiting",
  error: "Error",
};

function AgentItemLabel({ status }: { status: import("../electron.d").AgentStatus }) {
  const debounced = useDebouncedAgentStatus(status);
  return (
    <span className={styles.agentStatusLabel}>
      {STATUS_LABEL[debounced ?? ""] ?? debounced}
    </span>
  );
}

/** Strip braille spinners and done markers from an OSC title,
 *  returning null if the result is empty or just the generic agent name. */
function cleanAgentTitle(title: string | null | undefined): string | null {
  if (!title) return null;
  // Strip braille spinner chars (U+2800–U+28FF) and known done/brand markers
  let cleaned = title
    .replace(/[\u2800-\u28FF]/g, "")
    .replace(/[✳✻✽✶✢]/g, "")
    .trim();
  if (!cleaned) return null;
  // Ignore generic agent names — not useful as a display label
  const lower = cleaned.toLowerCase();
  if (lower === "claude code" || lower === "claude" || lower === "opencode" || lower === "codex") {
    return null;
  }
  return cleaned;
}

const STATUS_PRIORITY: AgentStatus[] = [
  "error",
  "requires_input",
  "working",
  "thinking",
  "complete",
  "idle",
];

function aggregateStatus(agents: WorkspaceAgent[]): AgentStatus | undefined {
  let best: AgentStatus | undefined;
  let bestRank = STATUS_PRIORITY.length;
  for (const a of agents) {
    const rank = STATUS_PRIORITY.indexOf(a.agent.status);
    if (rank !== -1 && rank < bestRank) {
      bestRank = rank;
      best = a.agent.status;
    }
  }
  return best;
}

function WorkspaceAgentList({
  workspacePath,
  onNavigate,
}: {
  workspacePath: string;
  onNavigate: (agent: WorkspaceAgent) => void;
}) {
  const agents = useWorkspaceAgents(workspacePath);
  const [expanded, setExpanded] = useState(true);

  if (agents.length === 0) return null;

  return (
    <div className={styles.agentAccordion}>
      <button
        className={styles.agentToggle}
        onClick={() => setExpanded((v) => !v)}
      >
        <span
          className={`${styles.agentToggleChevron} ${expanded ? styles.agentToggleChevronOpen : ""}`}
        >
          <ChevronRight size={10} />
        </span>
        <span>Tasks</span>
        {!expanded && <AgentDot status={aggregateStatus(agents)} size="sidebar" />}
        <span className={styles.agentCount}>{agents.length}</span>
      </button>
      {expanded && (
        <div className={styles.agentList}>
          {agents.map((a) => (
            <button
              key={a.paneId}
              className={styles.agentItem}
              onClick={() => onNavigate(a)}
            >
              <AgentDot status={a.agent.status} size="sidebar" />
              <span className={styles.agentName}>
                {cleanAgentTitle(a.agent.title) || a.agent.kind || "Agent"}
              </span>
              <AgentItemLabel status={a.agent.status} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
