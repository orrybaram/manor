import { useCallback, useState } from "react";
import { useAppStore } from "../../store/app-store";
import type { ProjectInfo } from "../../store/project-store";
import type { HealthCheckResult } from "../../lib/hosts";
import { ipcErrorMessage } from "../../lib/ipc-error";

export type HostCloneStep = "form" | "starting" | "cloning" | "health";

export type UseHostCloneFlowOptions = {
  hostId: string;
  /** Performs the clone (or move) itself; resolves with the resulting project. */
  run: () => Promise<ProjectInfo>;
  /**
   * Stop after the clone instead of moving on to the health step — a clone
   * on this machine goes to `ProjectSetupWizard` instead. `step`
   * returns to "form" and the caller takes it from there.
   */
  skipHealthChecks?: boolean;
  /**
   * `run` starts a new pod first: the flow opens on a
   * "Starting <profile> pod" step and moves on to "cloning" when the clone's
   * first progress arrives.
   */
  newPod?: boolean;
};

export type UseHostCloneFlowResult = {
  step: HostCloneStep;
  progressLines: string[];
  error: string | null;
  project: ProjectInfo | null;
  checks: HealthCheckResult[] | null;
  checksRunning: boolean;
  /**
   * Runs `run()`, streaming progress into `progressLines`, then
   * health-checks (unless `skipHealthChecks`). Resolves with the project on success, or null after an
   * error (already reflected in `error`).
   */
  start: () => Promise<ProjectInfo | null>;
  rerun: () => void;
  fix: (check: HealthCheckResult) => void;
  reset: () => void;
};

/**
 * The form → cloning → health state machine shared by `AddProjectDialog`'s
 * remote flow and `CloneToHostDialog`. `run` is the only thing that differs
 * between the two callers: `cloneProject` or `moveProjectToHost`.
 */
export function useHostCloneFlow(options: UseHostCloneFlowOptions): UseHostCloneFlowResult {
  const { hostId, run, skipHealthChecks = false, newPod = false } = options;

  const [step, setStep] = useState<HostCloneStep>("form");
  const [progressLines, setProgressLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [checks, setChecks] = useState<HealthCheckResult[] | null>(null);
  const [checksRunning, setChecksRunning] = useState(false);

  const reset = useCallback(() => {
    setStep("form");
    setProgressLines([]);
    setError(null);
    setProject(null);
    setChecks(null);
    setChecksRunning(false);
  }, []);

  const runHealthChecks = useCallback(
    async (path: string, onHostId: string = hostId) => {
      setChecksRunning(true);
      try {
        const results = await window.electronAPI.hosts.healthCheck(onHostId, path);
        setChecks(results);
      } catch (err) {
        setError(ipcErrorMessage(err));
      } finally {
        setChecksRunning(false);
      }
    },
    [hostId],
  );

  const start = useCallback(async () => {
    setError(null);
    setProgressLines([]);
    setStep(newPod ? "starting" : "cloning");

    const unsub = window.electronAPI.projects.onCloneProgress((event) => {
      if (event.status === "error") {
        setError(event.message ?? "Clone failed");
        return;
      }
      if (event.message) {
        setProgressLines((lines) => [...lines, event.message!]);
        setStep((current) => (current === "starting" ? "cloning" : current));
      }
    });

    try {
      const result = await run();
      unsub();
      setProject(result);
      if (skipHealthChecks) {
        setStep("form");
        return result;
      }
      setStep("health");
      // A new pod's host is only known once it is made.
      void runHealthChecks(result.path, newPod ? result.hostId : hostId);
      return result;
    } catch (err) {
      unsub();
      setError(ipcErrorMessage(err));
      setStep("form");
      return null;
    }
  }, [run, runHealthChecks, skipHealthChecks, newPod, hostId]);

  const rerun = useCallback(() => {
    if (project) void runHealthChecks(project.path, newPod ? project.hostId : hostId);
  }, [project, runHealthChecks, newPod, hostId]);

  const fix = useCallback(
    (check: HealthCheckResult) => {
      if (!check.fixCommand || !project) return;
      const ws = project.workspaces.find((w) => w.isMain) ?? project.workspaces[0];
      if (!ws) return;
      useAppStore.getState().setActiveWorkspace(ws.path, project.hostId);
      useAppStore.getState().addTerminalTab(check.fixCommand, { submit: false });
    },
    [project],
  );

  return { step, progressLines, error, project, checks, checksRunning, start, rerun, fix, reset };
}
