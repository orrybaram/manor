import {
  lazy,
  Suspense,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import ExternalLink from "lucide-react/dist/esm/icons/external-link";
import { useMountEffect } from "../../../hooks/useMountEffect";
import { projectColorStyle } from "../../../hooks/useProjectHeaderRow";
import { openExternal } from "../../../lib/open-external";
import type { NewWorkspaceHandler } from "../../../lib/start-issue-work";
import {
  initialOf,
  relativeTime,
  type TaskDetail as TaskDetailData,
  type TaskRef,
  type TaskRow,
} from "../../../lib/tasks";
import { trackerFor } from "../../../lib/trackers";
import { addErrorToast } from "../../../store/toast-store";
import { Button } from "../../ui/Button/Button";
import { Link } from "../../ui/Link/Link";
import { PriorityIcon } from "../PriorityIcon";
import { TrackerRowIcon } from "../tracker-icons";
import { useStartTask } from "../useStartTask";
import { TaskBodySkeleton, TaskMetaSkeleton } from "./TaskDetailSkeleton";
import tasksStyles from "../TasksView.module.css";
import styles from "./TaskDetail.module.css";

const TaskMarkdown = lazy(() => import("./TaskMarkdown"));

type TaskDetailProps = {
  taskRef: TaskRef;
  /** The listed row, when there is one — Start needs it. */
  row?: TaskRow;
  /** `linked`: the task is linked to a workspace — Unlink / Close & Unlink instead of Start. */
  mode: "default" | "linked";
  /** `card`: body beside meta (palette, dialogs). `drawer`: one narrow column (Tasks view). */
  layout: "card" | "drawer";
  /** The linked workspace's label (linked mode). */
  linkedTo?: string;
  /** The linked workspace's project and path (linked mode): what Unlink detaches from. */
  projectId?: string;
  workspacePath?: string;
  onNewWorkspace: NewWorkspaceHandler;
  /** After an action that should close the host (started, opened, unlinked…). */
  onDone: () => void;
  /** Handle ⌘↵ (Start) / ⌘O on `window` while mounted (default true). */
  keyboard?: boolean;
};

/** Focus in a text field keeps its own ⌘↵ (e.g. a commit message's submit). */
function inTextField(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.closest("input, textarea, select") !== null)
  );
}

/** A card takes focus so the host's (possibly hidden) search input doesn't keep the keys. */
function focusOnMount(el: HTMLDivElement | null) {
  el?.focus({ preventScroll: true });
}

/**
 * ADR-208 §2: one task's detail — tracker-agnostic, fed by the tracker seam's
 * `detailQuery`. Renders title, status, assignees, project, labels,
 * priority / milestone, the body and its images, and the action bar.
 */
export function TaskDetail(props: TaskDetailProps) {
  const {
    taskRef,
    row,
    mode,
    layout,
    linkedTo,
    projectId,
    workspacePath,
    onNewWorkspace,
    onDone,
    keyboard = true,
  } = props;

  const tracker = trackerFor(taskRef.provider);
  const startTask = useStartTask(onNewWorkspace);
  const [busy, setBusy] = useState(false);

  const { data: detail, isLoading, error, refetch } = useQuery({
    ...tracker.detailQuery(taskRef),
    // Tracker failures (not found, auth) are deterministic; Retry is offered instead.
    retry: false,
  });

  const canStart = mode === "default" && row !== undefined;

  const handleStart = async () => {
    if (!row) return;
    try {
      await startTask(row);
    } catch (err) {
      addErrorToast(`start-task-error-${row.key}`, "Failed to start task", err);
      return;
    }
    onDone();
  };

  const handleOpen = () => {
    openExternal(taskRef.url);
    onDone();
  };

  const handleUnlink = async () => {
    if (!projectId || !workspacePath || !tracker.unlink) return;
    setBusy(true);
    try {
      await tracker.unlink(taskRef, projectId, workspacePath);
    } catch (err) {
      addErrorToast(
        `unlink-issue-error-${taskRef.id}`,
        "Failed to unlink task",
        err,
      );
      setBusy(false);
      return;
    }
    onDone();
  };

  const handleCloseAndUnlink = async () => {
    if (!projectId || !workspacePath || !tracker.close || !tracker.unlink) {
      return;
    }
    setBusy(true);
    try {
      await tracker.close(taskRef);
    } catch (err) {
      addErrorToast(
        `close-issue-error-${taskRef.id}`,
        "Failed to close task",
        err,
      );
      setBusy(false);
      return;
    }
    onDone();
    try {
      await tracker.unlink(taskRef, projectId, workspacePath);
    } catch (err) {
      // The task genuinely is closed now — surface the stale link without
      // undoing the close.
      addErrorToast(
        `unlink-after-close-error-${taskRef.id}`,
        "Task closed, but failed to unlink",
        err,
      );
    }
  };

  // Keyboard shortcuts — refs hold latest values so the mount effect never re-subscribes.
  const latest = {
    keyboard,
    mode,
    canStart,
    handleStart,
    handleOpen,
  };
  const latestRef = useRef(latest);
  latestRef.current = latest;

  useMountEffect(() => {
    // ⌘-chords on keydown: macOS swallows a key's keyup while ⌘ is held.
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      const l = latestRef.current;
      if (!l.keyboard || !(e.metaKey || e.ctrlKey)) return;
      if (e.key === "o") {
        e.preventDefault();
        l.handleOpen();
      } else if (
        e.key === "Enter" &&
        l.mode === "default" &&
        l.canStart &&
        !inTextField(e.target)
      ) {
        e.preventDefault();
        void l.handleStart();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const status = detail?.status ?? row?.status;
  const statusPill = status && (
    <span
      className={`${tasksStyles.status} ${tasksStyles[`tone-${status.tone}`]}`}
    >
      {status.label}
    </span>
  );

  const meta = isLoading ? (
    <TaskMetaSkeleton />
  ) : (
    <TaskMeta
      detail={detail}
      row={row}
      taskRef={taskRef}
      statusPill={layout === "drawer" ? statusPill : undefined}
    />
  );

  const body = isLoading ? (
    <TaskBodySkeleton />
  ) : detail ? (
    <TaskBody provider={taskRef.provider} detail={detail} />
  ) : (
    <TaskDetailError
      taskRef={taskRef}
      trackerLabel={tracker.label}
      error={error}
      onRetry={() => refetch()}
    />
  );

  const title = <h2 className={styles.title}>{taskRef.title}</h2>;

  // The drawer's host header carries the open link (ADR-208 §3).
  const openLink = layout === "card" && taskRef.url && (
    <Link
      href={taskRef.url}
      variant="plain"
      className={styles.openLink}
      onClick={onDone}
    >
      <ExternalLink size={13} aria-hidden />
      Open in {tracker.label}
      {keyboard && <kbd className={styles.kbd}>⌘O</kbd>}
    </Link>
  );

  const actions = (
    <div className={styles.actions}>
      {mode === "linked" ? (
        <>
          {linkedTo && (
            <span className={styles.linked}>
              Linked to <strong>{linkedTo}</strong>
            </span>
          )}
          {tracker.unlink && (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={handleUnlink}
            >
              Unlink
            </Button>
          )}
          {tracker.close && tracker.unlink && (
            <Button
              size="sm"
              variant="danger"
              disabled={busy}
              onClick={handleCloseAndUnlink}
            >
              Close &amp; Unlink
            </Button>
          )}
        </>
      ) : (
        <>
          {canStart && (
            <Button size="sm" variant="primary" onClick={handleStart}>
              {layout === "card" ? "Start in new workspace" : "Start"}
              {keyboard && <kbd className={styles.kbd}>⌘↵</kbd>}
            </Button>
          )}
        </>
      )}
      <span className={styles.spacer} />
      {openLink}
    </div>
  );

  return (
    <div
      className={`${styles.root} ${styles[layout]}`}
      data-testid="task-detail"
      tabIndex={-1}
      ref={layout === "card" && keyboard ? focusOnMount : undefined}
    >
      {layout === "card" ? (
        <div className={styles.layout}>
          <div className={styles.main}>
            <div className={styles.header}>
              <span className={styles.displayId}>
                <TrackerRowIcon provider={taskRef.provider} />
                {taskRef.displayId}
              </span>
              {statusPill}
            </div>
            {title}
            {body}
          </div>
          <div className={styles.meta}>{meta}</div>
        </div>
      ) : (
        <div className={styles.layout}>
          {title}
          <div className={styles.meta}>{meta}</div>
          <div className={styles.main}>{body}</div>
        </div>
      )}
      {actions}
    </div>
  );
}

type MetaFieldProps = {
  label: string;
  children: ReactNode;
};

function MetaField(props: MetaFieldProps) {
  const { label, children } = props;

  return (
    <div className={styles.metaField}>
      <span className={styles.metaLabel}>{label}</span>
      <span className={styles.metaValue}>{children}</span>
    </div>
  );
}

type TaskMetaProps = {
  detail: TaskDetailData | undefined;
  row: TaskRow | undefined;
  taskRef: TaskRef;
  /** The drawer has no header line, so its status is a meta field. */
  statusPill: ReactNode;
};

/** The meta fields; a field the task has nothing for is left out. */
function TaskMeta(props: TaskMetaProps) {
  const { detail, row, taskRef, statusPill } = props;

  const [now] = useState(() => Date.now());
  const assignees = detail?.assignees ?? row?.assignees ?? [];
  const labels = detail?.labels ?? row?.labels ?? [];
  const priority = detail?.priority ?? row?.priority;
  const milestone = detail?.milestone ?? row?.milestone;
  const projectName = row?.projectName ?? taskRef.project.name;
  const projectColor = row ? row.color : taskRef.project.color;
  const updated = row ? relativeTime(row.updatedAt, now) : "";

  return (
    <>
      {statusPill && <MetaField label="Status">{statusPill}</MetaField>}
      {assignees.length > 0 && (
        <MetaField label={assignees.length > 1 ? "Assignees" : "Assignee"}>
          {assignees.map((name) => (
            <span key={name} className={styles.assignee}>
              <span className={tasksStyles.avatar} aria-hidden>
                {initialOf(name)}
              </span>
              {name}
            </span>
          ))}
        </MetaField>
      )}
      {projectName && (
        <MetaField label="Project">
          <span
            className={tasksStyles.projectName}
            style={projectColorStyle(projectColor)}
          >
            {projectName}
          </span>
        </MetaField>
      )}
      {labels.length > 0 && (
        <MetaField label="Labels">
          {labels.map((label) => (
            <span
              key={label.name}
              className={tasksStyles.label}
              style={
                label.color
                  ? ({ "--label-color": label.color } as CSSProperties)
                  : undefined
              }
            >
              {label.name}
            </span>
          ))}
        </MetaField>
      )}
      {priority && priority.value > 0 && (
        <MetaField label="Priority">
          <PriorityIcon value={priority.value} />
          {priority.label}
        </MetaField>
      )}
      {milestone && <MetaField label="Milestone">{milestone}</MetaField>}
      {updated && <MetaField label="Updated">{updated}</MetaField>}
    </>
  );
}

type TaskBodyProps = {
  provider: TaskRef["provider"];
  detail: TaskDetailData;
};

function TaskBody(props: TaskBodyProps) {
  const { provider, detail } = props;

  if (!detail.body?.trim()) {
    return <div className={styles.empty}>No description.</div>;
  }

  return (
    <div className={styles.markdown}>
      <Suspense fallback={<p className={styles.description}>{detail.body}</p>}>
        <TaskMarkdown provider={provider} source={detail.body} />
      </Suspense>
    </div>
  );
}

type TaskDetailErrorProps = {
  taskRef: TaskRef;
  trackerLabel: string;
  error: unknown;
  onRetry: () => void;
};

function TaskDetailError(props: TaskDetailErrorProps) {
  const { taskRef, trackerLabel, error, onRetry } = props;

  const message =
    error instanceof Error ? error.message : error ? String(error) : null;

  return (
    <div className={styles.error} role="alert">
      <p className={styles.errorTitle}>
        Couldn't load task {taskRef.displayId}
      </p>
      {message && <div className={styles.description}>{message}</div>}
      <div className={styles.errorActions}>
        <Button size="sm" onClick={onRetry}>
          Retry
        </Button>
        {taskRef.url && (
          <Link href={taskRef.url}>Open in {trackerLabel}</Link>
        )}
      </div>
    </div>
  );
}
