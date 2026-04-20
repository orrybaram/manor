import { useEffect, useCallback } from "react";
import Circle from "lucide-react/dist/esm/icons/circle";
import Loader2 from "lucide-react/dist/esm/icons/loader-2";
import Check from "lucide-react/dist/esm/icons/check";
import X from "lucide-react/dist/esm/icons/x";
import { useAppStore } from "../../store/app-store";
import type { SetupStep, StepStatus } from "../../store/project-store";
import { ManorLogo } from "../ui/ManorLogo";
import { Row, Stack } from "../ui/Layout/Layout";
import { Button } from "../ui/Button/Button";
import { MiniTerminal } from "../ui/MiniTerminal";
import styles from "./WorkspaceSetupView.module.css";

interface WorkspaceSetupViewProps {
  workspacePath: string;
  onComplete: () => void;
}

const STEP_LABELS: Record<SetupStep, string> = {
  prune: "Pruning stale worktrees",
  fetch: "Fetching from remote",
  "create-worktree": "Creating git worktree",
  persist: "Saving workspace",
  switch: "Switching to workspace",
  "setup-script": "Running setup script",
};

function getStepLabel(step: SetupStep, message?: string): string {
  const base = STEP_LABELS[step];
  if (step === "create-worktree" && message) {
    return `${base} (${message})`;
  }
  return base;
}

function StepIcon({ status }: { status: StepStatus }) {
  switch (status) {
    case "pending":
      return <Circle size={14} />;
    case "in-progress":
      return <Loader2 size={14} className={styles.spinner} />;
    case "done":
      return <Check size={14} />;
    case "error":
      return <X size={14} />;
  }
}

const STATUS_CLASS: Record<StepStatus, string> = {
  pending: styles.stepPending,
  "in-progress": styles.stepInProgress,
  done: styles.stepDone,
  error: styles.stepError,
};

function SetupChecklist({
  steps,
}: {
  steps: Array<{ step: SetupStep; status: StepStatus; message?: string }>;
}) {
  return (
    <Stack gap="2xs" className={styles.checklist}>
      {steps.map((s) => (
        <div
          key={s.step}
          className={`${styles.stepRow} ${STATUS_CLASS[s.status]}`}
        >
          <span className={styles.stepIcon}>
            <StepIcon status={s.status} />
          </span>
          <span className={styles.stepLabel}>
            {getStepLabel(s.step, s.message)}
          </span>
        </div>
      ))}
    </Stack>
  );
}

export function WorkspaceSetupView({
  workspacePath,
  onComplete,
}: WorkspaceSetupViewProps) {
  const setupState = useAppStore((s) => s.worktreeSetupState[workspacePath]);
  const updateStep = useAppStore((s) => s.updateWorktreeSetupStep);
  const completeSetup = useAppStore((s) => s.completeWorktreeSetup);

  const steps = setupState?.steps ?? [];
  const startScript = setupState?.startScript;

  const hasSetupScriptStep = steps.some((s) => s.step === "setup-script");
  const setupScriptStep = steps.find((s) => s.step === "setup-script");
  const allNonScriptDone = steps
    .filter((s) => s.step !== "setup-script")
    .every((s) => s.status === "done");
  const allDone = steps.length > 0 && steps.every((s) => s.status === "done");

  // Derive fading from whether all steps are done
  const fading = allDone;

  // Transition setup-script to in-progress when all other steps are done
  useEffect(() => {
    if (
      hasSetupScriptStep &&
      allNonScriptDone &&
      setupScriptStep?.status === "pending"
    ) {
      updateStep(workspacePath, "setup-script", "in-progress");
    }
  }, [
    hasSetupScriptStep,
    allNonScriptDone,
    setupScriptStep?.status,
    updateStep,
    workspacePath,
  ]);

  // Mark setup as complete in the store when all steps finish
  useEffect(() => {
    if (allDone) {
      completeSetup(workspacePath);
    }
  }, [allDone, completeSetup, workspacePath]);

  const handleTransitionEnd = useCallback(() => {
    if (fading) {
      onComplete();
    }
  }, [fading, onComplete]);

  const handleTerminalExit = useCallback(() => {
    updateStep(workspacePath, "setup-script", "done");
  }, [updateStep, workspacePath]);

  const handleSkip = useCallback(() => {
    // Force all steps to done so the setup view can dismiss
    for (const s of steps) {
      if (s.status !== "done") {
        updateStep(workspacePath, s.step, "done");
      }
    }
  }, [steps, updateStep, workspacePath]);

  const terminalSessionId = `setup-${workspacePath.replace(/\//g, "-")}`;
  const showTerminal =
    hasSetupScriptStep &&
    startScript &&
    setupScriptStep?.status === "in-progress";

  return (
    <div
      className={`${fading ? styles.fadeOut : ""}`}
      onTransitionEnd={handleTransitionEnd}
      style={{ height: "100%", opacity: fading ? undefined : 1 }}
    >
      <Row align="center" justify="center" className={styles.container}>
        <Stack gap="xl" className={styles.content}>
        <div className={styles.logo}>
          <ManorLogo />
          <p className={styles.subtitle}>Setting up workspace...</p>
        </div>

        <SetupChecklist steps={steps} />

        {showTerminal && (
          <div className={styles.terminalContainer}>
            <MiniTerminal
              sessionId={terminalSessionId}
              cwd={workspacePath}
              command={startScript}
              interactive={false}
              exitOnComplete
              attach
              onExit={handleTerminalExit}
              autoStart
              className={styles.terminal}
            />
          </div>
        )}

        {!fading && (
          <Button variant="ghost" size="sm" onClick={handleSkip}>
            Skip
          </Button>
        )}
      </Stack>
      </Row>
    </div>
  );
}
