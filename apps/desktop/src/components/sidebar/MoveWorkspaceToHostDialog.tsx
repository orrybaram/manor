import { useCallback, useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import Laptop from "lucide-react/dist/esm/icons/laptop";
import Server from "lucide-react/dist/esm/icons/server";
import { useProjectStore } from "../../store/project-store";
import { useHostStore } from "../../store/host-store";
import { useAppStore } from "../../store/app-store";
import { memberDisplayName } from "../../bridge/server-set";
import { isRemoteHost } from "../../lib/hosts";
import { ipcErrorMessage } from "../../lib/ipc-error";
import { workspaceMoveTargets } from "../../lib/transfer-targets";
import { workspaceDisplayName } from "../../lib/sidebar-rail";
import {
  LANE_START,
  advanceLane,
  dirtySentence,
  failureBody,
  laneView,
  refusalSentence,
  stepLabel,
  type LaneProgress,
} from "../../lib/workspace-host-move-view";
import type { WorkspaceMovePreflight, WorkspaceMoveStepId } from "../../electron";
import { onUiRequest } from "../../utils/ui-request";
import { Button } from "../ui/Button/Button";
import { Checkbox } from "../ui/Checkbox/Checkbox";
import dialogStyles from "./dialogs.module.css";
import styles from "./MoveWorkspaceToHostDialog.module.css";

/** How long "Moved to <host>" shows before the dialog closes onto it. */
const SUCCESS_HOLD_MS = 700;

interface Opening {
  projectId: string;
  path: string;
  hostId: string | null;
  key: number;
}

let nextOpeningKey = 0;

/**
 * The app-wide mount for the Move to Host dialog, opened by a
 * `move-workspace-to-host` UI request from the workspace menu or the palette.
 * It lives outside the sidebar so a move outlasts the sidebar's rows (the
 * source row goes away mid-move) and a hidden sidebar.
 */
export function MoveWorkspaceToHostDialogHost() {
  const [opening, setOpening] = useState<Opening | null>(null);

  useEffect(
    () =>
      onUiRequest((request) => {
        if (request.type !== "move-workspace-to-host") return;
        // One at a time: the open dialog is modal, so a second request
        // can only come from outside it (the native menu).
        setOpening(
          (current) =>
            current ?? {
              projectId: request.projectId,
              path: request.path,
              hostId: request.hostId ?? null,
              key: nextOpeningKey++,
            },
        );
      }),
    [],
  );

  if (!opening) return null;
  return (
    <MoveWorkspaceToHostDialog
      key={opening.key}
      projectId={opening.projectId}
      path={opening.path}
      initialHostId={opening.hostId}
      onClose={() => setOpening(null)}
    />
  );
}

type Phase = "pick" | "confirm" | "moving" | "failed";

type PreflightState =
  | { status: "loading" }
  | { status: "ready"; pre: WorkspaceMovePreflight }
  | { status: "error"; error: string };

interface Failure {
  step: WorkspaceMoveStepId | null;
  error: string;
}

interface MoveWorkspaceToHostDialogProps {
  projectId: string;
  path: string;
  /** Null asks which host first. */
  initialHostId: string | null;
  onClose: () => void;
}

/** Open the moved workspace, from a project list that has it. */
function openMovedWorkspace(projectId: string, path: string, hostId: string): void {
  const store = useProjectStore.getState();
  const project = store.projects.find((p) => p.id === projectId);
  const index = project?.workspaces.findIndex((w) => w.path === path) ?? -1;
  if (project && index >= 0) {
    store.selectWorkspace(project.id, index);
    return;
  }
  useAppStore.getState().setActiveWorkspace(path, hostId);
}

function HostGlyph({ hostId }: { hostId: string }) {
  return isRemoteHost(hostId) ? (
    <Server size={26} strokeWidth={1.6} aria-hidden />
  ) : (
    <Laptop size={26} strokeWidth={1.6} aria-hidden />
  );
}

function MoveWorkspaceToHostDialog(props: MoveWorkspaceToHostDialogProps) {
  const { projectId, path, initialHostId, onClose } = props;
  const hosts = useHostStore((s) => s.hosts);

  // Taken once: the source workspace leaves the project list mid-move.
  const [source] = useState(() => {
    const project = useProjectStore.getState().projects.find((p) => p.id === projectId);
    const ws = project?.workspaces.find((w) => w.path === path);
    if (!project || !ws) return null;
    return {
      project,
      hostId: project.hostId,
      name: workspaceDisplayName(ws, null),
    };
  });

  const [phase, setPhase] = useState<Phase>(initialHostId ? "confirm" : "pick");
  const [hostId, setHostId] = useState<string | null>(initialHostId);
  const [preflight, setPreflight] = useState<PreflightState>({ status: "loading" });
  const [removeSource, setRemoveSource] = useState(true);
  const [lane, setLane] = useState<LaneProgress>(LANE_START);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const lastStep = useRef<WorkspaceMoveStepId | null>(null);
  const preflightToken = useRef(0);

  const runPreflight = useCallback(
    async (target: string): Promise<WorkspaceMovePreflight | null> => {
      const token = ++preflightToken.current;
      setPreflight({ status: "loading" });
      try {
        const pre = await window.electronAPI.projects.moveWorkspaceToHostPreflight({
          projectId,
          path,
          targetHostId: target,
        });
        if (token !== preflightToken.current) return null;
        setPreflight({ status: "ready", pre });
        return pre;
      } catch (err) {
        if (token !== preflightToken.current) return null;
        setPreflight({ status: "error", error: ipcErrorMessage(err) });
        return null;
      }
    },
    [projectId, path],
  );

  useEffect(() => {
    if (initialHostId) void runPreflight(initialHostId);
  }, [initialHostId, runPreflight]);

  useEffect(() => {
    if (!source) onClose();
  }, [source, onClose]);
  if (!source || (hostId === null && phase !== "pick")) return null;

  const sourceName = memberDisplayName(source.hostId, hosts);
  const targetName = hostId ? memberDisplayName(hostId, hosts) : "";
  const busy = phase === "moving";

  const startMove = async (target: string) => {
    const moveId = crypto.randomUUID();
    lastStep.current = null;
    setLane(LANE_START);
    setFailure(null);
    setShowDetails(false);
    setPhase("moving");
    const unsubscribe = window.electronAPI.projects.onMoveWorkspaceToHostProgress((event) => {
      if (event.moveId !== moveId) return;
      if (event.type === "step") lastStep.current = event.step;
      setLane((current) => advanceLane(current, event));
    });
    let result;
    try {
      result = await window.electronAPI.projects.moveWorkspaceToHost({
        projectId,
        path,
        targetHostId: target,
        keepSource: !removeSource,
        moveId,
      });
    } catch (err) {
      setFailure({ step: lastStep.current, error: ipcErrorMessage(err) });
      setPhase("failed");
      return;
    } finally {
      unsubscribe();
    }

    if (result.ok) {
      setLane((current) => ({ ...current, succeeded: true }));
      // The new member and workspace have to be in the list to be opened.
      const loaded = useProjectStore.getState().loadProjects().catch(() => {});
      await Promise.all([
        loaded,
        new Promise((resolve) => setTimeout(resolve, SUCCESS_HOLD_MS)),
      ]);
      onClose();
      openMovedWorkspace(result.targetProjectId, result.targetPath, target);
      return;
    }
    if ("needsInput" in result) {
      // The set up wants the user: hand over to the Set up dialog.
      onClose();
      useProjectStore.getState().openTransferDialog({
        projectId,
        hostId: target,
        mode: "setUp",
        reason: result.needsInput.reason,
        repoUrl: result.needsInput.repoUrl,
        targetDir: result.needsInput.targetDir,
      });
      return;
    }
    if ("refusals" in result) {
      // Something changed since the preflight: show what refuses it now.
      setPreflight((current) =>
        current.status === "ready"
          ? { status: "ready", pre: { ...current.pre, refusals: result.refusals } }
          : current,
      );
      setPhase("confirm");
      return;
    }
    setFailure({ step: result.step, error: result.error });
    setPhase("failed");
  };

  const retry = async () => {
    if (!hostId) return;
    setPhase("confirm");
    const pre = await runPreflight(hostId);
    if (pre && pre.refusals.length === 0) await startMove(hostId);
  };

  const pickHost = (target: string) => {
    setHostId(target);
    setPhase("confirm");
    void runPreflight(target);
  };

  const close = () => {
    if (!busy) onClose();
  };
  const holdOpen = (e: Event) => {
    if (busy) e.preventDefault();
  };

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={dialogStyles.confirmOverlay} />
        <Dialog.Content
          className={`${dialogStyles.confirmDialog} ${styles.dialog}`}
          data-testid="move-to-host-dialog"
          data-phase={phase}
          onEscapeKeyDown={holdOpen}
          onPointerDownOutside={holdOpen}
          onInteractOutside={holdOpen}
          {...(phase === "pick" ? { "aria-describedby": undefined } : {})}
        >
          {phase === "pick" && (
            <PickHost
              name={source.name}
              targets={workspaceMoveTargets(source.project, hosts)}
              onPick={pickHost}
              onCancel={onClose}
            />
          )}
          {phase === "confirm" && hostId && (
            <Confirm
              name={source.name}
              targetName={targetName}
              sourceName={sourceName}
              preflight={preflight}
              removeSource={removeSource}
              onRemoveSourceChange={setRemoveSource}
              onCancel={onClose}
              onMove={() => void startMove(hostId)}
            />
          )}
          {phase === "moving" && hostId && (
            <Moving
              name={source.name}
              sourceHostId={source.hostId}
              targetHostId={hostId}
              sourceName={sourceName}
              targetName={targetName}
              lane={lane}
            />
          )}
          {phase === "failed" && failure && (
            <>
              <Dialog.Title className={dialogStyles.confirmTitle}>
                Couldn&rsquo;t move &ldquo;{source.name}&rdquo;
              </Dialog.Title>
              <Dialog.Description
                className={dialogStyles.confirmDescription}
                data-testid="move-to-host-failed"
              >
                {failureBody(failure.step, lane.steps, targetName, sourceName)}
              </Dialog.Description>
              {showDetails && (
                <pre className={styles.details} data-testid="move-to-host-error">
                  {failure.error}
                </pre>
              )}
              <div className={`${dialogStyles.confirmActions} ${styles.actions}`}>
                <Button
                  variant="link"
                  className={styles.detailsToggle}
                  aria-expanded={showDetails}
                  data-testid="move-to-host-show-details"
                  onClick={() => setShowDetails((v) => !v)}
                >
                  {showDetails ? "Hide details" : "Show details"}
                </Button>
                <Button variant="secondary" onClick={onClose}>
                  Close
                </Button>
                <Button
                  variant="primary"
                  data-testid="move-to-host-retry"
                  onClick={() => void retry()}
                >
                  Retry
                </Button>
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function PickHost(props: {
  name: string;
  targets: ReturnType<typeof workspaceMoveTargets>;
  onPick: (hostId: string) => void;
  onCancel: () => void;
}) {
  const { name, targets, onPick, onCancel } = props;
  return (
    <>
      <Dialog.Title className={dialogStyles.confirmTitle}>
        Move &ldquo;{name}&rdquo; to&hellip;
      </Dialog.Title>
      {targets.length === 0 ? (
        <p className={styles.refusal}>There is no other host to move it to.</p>
      ) : (
        <ul className={styles.hostList} data-testid="move-to-host-picker">
          {targets.map((target) => (
            <li key={target.hostId}>
              <button
                type="button"
                className={styles.hostChoice}
                disabled={target.disabledReason !== null}
                title={target.disabledReason ?? undefined}
                data-testid={`move-to-host-pick-${target.hostId}`}
                onClick={() => onPick(target.hostId)}
              >
                {isRemoteHost(target.hostId) ? <Server size={16} /> : <Laptop size={16} />}
                {target.label}
                {target.disabledReason && (
                  <span className={styles.hostChoiceReason}>Offline</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className={`${dialogStyles.confirmActions} ${styles.actions}`}>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </>
  );
}

function Confirm(props: {
  name: string;
  targetName: string;
  sourceName: string;
  preflight: PreflightState;
  removeSource: boolean;
  onRemoveSourceChange: (value: boolean) => void;
  onCancel: () => void;
  onMove: () => void;
}) {
  const { name, targetName, sourceName, preflight, removeSource } = props;
  const pre = preflight.status === "ready" ? preflight.pre : null;
  const refusals = pre?.refusals ?? [];
  const dirty = refusals.find((r) => r.code === "dirty");
  const sentences = refusals
    .map((r) => refusalSentence(r, targetName, sourceName))
    .filter((s): s is string => s !== null);
  const refused = refusals.length > 0 || preflight.status === "error";
  const canMove = pre !== null && refusals.length === 0;

  return (
    <div data-testid="move-to-host-confirm" data-preflight={preflight.status}>
      <Dialog.Title className={dialogStyles.confirmTitle}>
        Move &ldquo;{name}&rdquo; to {targetName}?
      </Dialog.Title>
      <Dialog.Description className={dialogStyles.confirmDescription}>
        Your tabs come back on {targetName}, and agents pick up where they left off.
      </Dialog.Description>
      {dirty?.code === "dirty" && (
        <div className={styles.problem} data-testid="move-to-host-dirty">
          {dirtySentence(dirty.files.length)}
          <ul className={styles.files}>
            {dirty.files.map((file) => (
              <li key={file.path} title={file.path}>
                <span className={styles.fileCode}>{file.code.trim()}</span>
                {file.path}
              </li>
            ))}
          </ul>
        </div>
      )}
      {sentences.map((sentence) => (
        <p key={sentence} className={styles.refusal} data-testid="move-to-host-refusal">
          {sentence}
        </p>
      ))}
      {preflight.status === "error" && (
        <p className={styles.refusal} data-testid="move-to-host-refusal">
          Couldn&rsquo;t check this workspace: {preflight.error}
        </p>
      )}
      {pre?.existingTargetWorktree && !refused && (
        <div className={styles.warning} data-testid="move-to-host-reuse">
          {targetName} already has this branch checked out. The move will use it.
        </div>
      )}
      {!refused && (
        <label className={styles.removeSource}>
          <Checkbox
            size="md"
            checked={removeSource}
            onCheckedChange={(v) => props.onRemoveSourceChange(v === true)}
            data-testid="move-to-host-remove-source"
          />
          Remove from {sourceName} after moving
        </label>
      )}
      <div className={`${dialogStyles.confirmActions} ${styles.actions}`}>
        <Button variant="secondary" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={!canMove}
          data-testid="move-to-host-move"
          onClick={props.onMove}
        >
          Move
        </Button>
      </div>
    </div>
  );
}

function Moving(props: {
  name: string;
  sourceHostId: string;
  targetHostId: string;
  sourceName: string;
  targetName: string;
  lane: LaneProgress;
}) {
  const { name, sourceHostId, targetHostId, sourceName, targetName, lane } = props;
  const view = laneView(lane);
  const label = lane.succeeded
    ? `Moved to ${targetName}`
    : view.current
      ? stepLabel(view.current, targetName, sourceName)
      : "";
  const count = lane.succeeded ? "Opening workspace…" : view.count;
  const percent = `${view.fill * 100}%`;

  return (
    <div data-testid="move-to-host-moving" data-succeeded={lane.succeeded || undefined}>
      <Dialog.Title className={dialogStyles.confirmTitle}>
        Moving &ldquo;{name}&rdquo;
      </Dialog.Title>
      <div className={styles.stage}>
        <div
          className={styles.end}
          data-testid="move-to-host-source"
          data-dim={view.sourceDim || undefined}
        >
          <div className={styles.glyph}>
            <HostGlyph hostId={sourceHostId} />
          </div>
          <div className={styles.hostName}>{sourceName}</div>
        </div>
        <div className={styles.rail}>
          <div className={styles.track}>
            <div className={styles.fill} style={{ width: percent }} />
            <div
              className={styles.packet}
              style={{ left: percent }}
              data-hidden={lane.succeeded || undefined}
            />
          </div>
        </div>
        <div
          className={styles.end}
          data-testid="move-to-host-target"
          data-lit={(view.targetLit && !lane.succeeded) || undefined}
          data-ok={lane.succeeded || undefined}
        >
          <div className={styles.glyph}>
            <HostGlyph hostId={targetHostId} />
          </div>
          <div className={styles.hostName}>{targetName}</div>
        </div>
      </div>
      <Dialog.Description asChild>
        <div className={styles.status} aria-live="polite">
          <div key={label} className={styles.stepLabel} data-testid="move-to-host-step">
            {label}
          </div>
          <div className={styles.stepCount} data-testid="move-to-host-count">
            {count}
          </div>
        </div>
      </Dialog.Description>
    </div>
  );
}
