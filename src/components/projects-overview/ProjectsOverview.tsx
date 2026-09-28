import { useCallback, useMemo } from "react";
import FolderPlus from "lucide-react/dist/esm/icons/folder-plus";
import FolderGit2 from "lucide-react/dist/esm/icons/folder-git-2";
import { ManorLogo } from "../ui/ManorLogo";
import { Button } from "../ui/Button/Button";
import { useProjectStore, type ProjectInfo } from "../../store/project-store";
import { useAppStore } from "../../store/app-store";
import { useAgentStore } from "../../store/agent-store";
import { useHostStore } from "../../store/host-store";
import { memberHostName } from "../../lib/hosts";
import { projectCardSummary } from "../../lib/home-dashboard";
import { buildTopLevelEntries, type TopLevelEntry } from "../../utils/sidebar-items";
import { ProjectCard } from "./ProjectCard";
import shared from "../EmptyState.module.css";
import styles from "./ProjectsOverview.module.css";

export interface ProjectsOverviewProps {
  /** "Open a folder": the directory picker, straight away. */
  onAddLocal: () => void;
  /** "Clone from a repo": `AddProjectDialog` on its clone tab. */
  onClone: () => void;
}

/** The project a card opens: the entry itself, or a group's `lastUsedHostId` member. */
function entryTarget(entry: TopLevelEntry<ProjectInfo>): ProjectInfo | undefined {
  if (entry.kind === "project") return entry.project;
  return (
    entry.sections.find((s) => s.project.hostId === entry.group.lastUsedHostId)?.project ??
    entry.sections[0]?.project
  );
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * The Projects overview (ADR-194 §2–§3): an app-level surface shown from the
 * sidebar's Projects row, over whatever workspace is active — and, with zero
 * projects, the onboarding screen. One card per top-level sidebar entry, then
 * the "Add a project" card.
 */
export function ProjectsOverview(props: ProjectsOverviewProps) {
  const { onAddLocal, onClone } = props;

  const projects = useProjectStore((s) => s.projects);
  const selectProject = useProjectStore((s) => s.selectProject);
  const selectWorkspace = useProjectStore((s) => s.selectWorkspace);
  const paneAgentStatus = useAppStore((s) => s.paneAgentStatus);
  const agents = useAgentStore((s) => s.agents);
  const unseenRespondedAgentIds = useAgentStore((s) => s.unseenRespondedAgentIds);
  const hosts = useHostStore((s) => s.hosts);

  const entries = useMemo(() => buildTopLevelEntries(projects), [projects]);
  const cards = useMemo(() => {
    const deps = {
      projects,
      agents,
      paneAgentStatus,
      unseenRespondedAgentIds,
      hostName: (hostId: string) => memberHostName(hostId, hosts),
    };
    return entries.map((entry) => ({ entry, summary: projectCardSummary(entry, deps) }));
  }, [entries, projects, agents, paneAgentStatus, unseenRespondedAgentIds, hosts]);
  const hostCount = useMemo(() => new Set(projects.map((p) => p.hostId)).size, [projects]);

  const openEntry = useCallback(
    (entry: TopLevelEntry<ProjectInfo>) => {
      const project = entryTarget(entry);
      if (!project) return;
      const index = useProjectStore.getState().projects.findIndex((p) => p.id === project.id);
      if (index < 0) return;
      const wsIndex = project.selectedWorkspaceIndex;
      if (project.workspaces[wsIndex]) {
        // Also flips `activeSurface` back to "workspace" via `setActiveWorkspace`.
        selectWorkspace(project.id, wsIndex);
      } else if (project.workspaces[0]) {
        selectWorkspace(project.id, 0);
      } else {
        selectProject(index);
        useAppStore.setState({ activeSurface: "workspace" });
      }
    },
    [selectProject, selectWorkspace],
  );

  const empty = cards.length === 0;

  return (
    <div
      className={`${styles.container} ${empty ? styles.containerCentered : ""}`}
      data-testid="projects-overview"
    >
      <div className={styles.content}>
        {empty && (
          <div className={shared.logo}>
            <ManorLogo />
          </div>
        )}
        <div className={styles.header}>
          <h1 className={styles.heading}>Projects</h1>
          <span className={styles.headerMeta}>
            {empty
              ? "No projects yet"
              : `${plural(cards.length, "project")} · ${plural(hostCount, "host")}`}
          </span>
        </div>
        <div className={`${styles.cards} ${empty ? styles.cardsSingle : ""}`}>
          {cards.map(({ entry, summary }) => (
            <ProjectCard key={summary.key} summary={summary} onOpen={() => openEntry(entry)} />
          ))}
          <div className={styles.addCard} data-testid="add-project-card">
            <span className={styles.addCardTitle}>Add a project</span>
            <Button
              variant="ghost"
              className={`${shared.action} ${styles.row}`}
              onClick={onAddLocal}
              data-testid="import-project-button"
            >
              <span className={shared.actionIcon}>
                <FolderPlus size={16} />
              </span>
              <span className={shared.actionLabel}>Open a folder</span>
            </Button>
            <Button
              variant="ghost"
              className={`${shared.action} ${styles.row}`}
              onClick={onClone}
              data-testid="add-remote-project-button"
            >
              <span className={shared.actionIcon}>
                <FolderGit2 size={16} />
              </span>
              <span className={shared.actionLabel}>Clone from a repo</span>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
