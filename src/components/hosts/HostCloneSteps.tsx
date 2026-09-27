import type { HealthCheckResult } from "../../lib/hosts";
import { Button } from "../ui/Button/Button";
import { Input } from "../ui/Input";
import { Row, Stack } from "../ui/Layout/Layout";
import { CloneProgressLog } from "./CloneProgressLog";
import { HealthCheckList } from "./HealthCheckList";
import styles from "./HostCloneSteps.module.css";

type HostCloneStepsProps = {
  step: "cloning" | "health";
  progressLines: string[];
  checks: HealthCheckResult[] | null;
  checksRunning: boolean;
  onRerun: () => void;
  onFix: (check: HealthCheckResult) => void;
  onDone: () => void;
};

/**
 * The cloning-progress and post-clone health-check views shared by
 * `AddProjectDialog`'s remote flow and `CloneToHostDialog` (ADR-183 ticket
 * 10) — everything after the form, driven by `useHostCloneFlow`.
 */
export function HostCloneSteps(props: HostCloneStepsProps) {
  const { step, progressLines, checks, checksRunning, onRerun, onFix, onDone } = props;

  if (step === "cloning") {
    return <CloneProgressLog lines={progressLines} />;
  }

  return (
    <Stack gap="sm">
      <HealthCheckList checks={checks} running={checksRunning} onRerun={onRerun} onFix={onFix} />
      <Row justify="flex-end">
        <Button variant="primary" onClick={onDone}>
          Done
        </Button>
      </Row>
    </Stack>
  );
}

type RepoUrlAndRemoteDirFieldsProps = {
  idPrefix: string;
  repoUrl: string;
  onRepoUrlChange: (value: string) => void;
  remoteDir: string;
  onRemoteDirChange: (value: string) => void;
};

/**
 * The "Repo URL" / "Remote directory" field pair shared by both clone
 * dialogs (ADR-183 ticket 10).
 */
export function RepoUrlAndRemoteDirFields(props: RepoUrlAndRemoteDirFieldsProps) {
  const { idPrefix, repoUrl, onRepoUrlChange, remoteDir, onRemoteDirChange } = props;

  return (
    <>
      <Stack>
        <label className={styles.fieldLabel} htmlFor={`${idPrefix}-repo-url`}>
          Repo URL
        </label>
        <Input
          id={`${idPrefix}-repo-url`}
          value={repoUrl}
          onChange={(e) => onRepoUrlChange(e.target.value)}
          placeholder="git@github.com:org/repo.git"
        />
      </Stack>
      <Stack>
        <label className={styles.fieldLabel} htmlFor={`${idPrefix}-remote-dir`}>
          Remote directory
        </label>
        <Input
          id={`${idPrefix}-remote-dir`}
          value={remoteDir}
          onChange={(e) => onRemoteDirChange(e.target.value)}
          placeholder="~/code/repo"
        />
      </Stack>
    </>
  );
}
