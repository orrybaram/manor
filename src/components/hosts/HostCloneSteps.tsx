import type { ReactNode } from "react";
import CircleAlert from "lucide-react/dist/esm/icons/circle-alert";
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
 * `AddProjectDialog`'s remote clone and `CloneToHostDialog` (ADR-183 ticket
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

type RepoUrlFieldProps = {
  id: string;
  value: string;
  onChange: (value: string) => void;
  /** Overrides the "Repo URL" label, e.g. when a repo picker sits above it. */
  label?: string;
};

/** The "Repo URL" field shared by both clone dialogs (ADR-183 ticket 10). */
export function RepoUrlField(props: RepoUrlFieldProps) {
  const { id, value, onChange, label = "Repo URL" } = props;

  return (
    <Stack>
      <label className={styles.fieldLabel} htmlFor={id}>
        {label}
      </label>
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="git@github.com:org/repo.git"
      />
    </Stack>
  );
}

type CloneDirFieldProps = {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Rendered beside the input — `AddProjectDialog`'s "Browse…" (ADR-194). */
  action?: ReactNode;
};

/**
 * Where the clone goes: "Remote directory" in `CloneToHostDialog`,
 * "Location" in `AddProjectDialog` (ADR-194), which can target this machine.
 */
export function CloneDirField(props: CloneDirFieldProps) {
  const { id, label, value, onChange, placeholder = "~/code/repo", action } = props;

  const input = (
    <Input
      id={id}
      className={action ? styles.fieldGrow : undefined}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
    />
  );

  return (
    <Stack>
      <label className={styles.fieldLabel} htmlFor={id}>
        {label}
      </label>
      {action ? (
        <Row gap="sm" align="center">
          {input}
          {action}
        </Row>
      ) : (
        input
      )}
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

/** The "Repo URL" / "Remote directory" field pair `CloneToHostDialog` uses. */
export function RepoUrlAndRemoteDirFields(props: RepoUrlAndRemoteDirFieldsProps) {
  const { idPrefix, repoUrl, onRepoUrlChange, remoteDir, onRemoteDirChange } = props;

  return (
    <>
      <RepoUrlField id={`${idPrefix}-repo-url`} value={repoUrl} onChange={onRepoUrlChange} />
      <CloneDirField
        id={`${idPrefix}-remote-dir`}
        label="Remote directory"
        value={remoteDir}
        onChange={onRemoteDirChange}
      />
    </>
  );
}

/** `text` with each `backtick span` rendered as inline code. */
function withInlineCode(text: string): ReactNode[] {
  return text.split("`").map((part, i) => (i % 2 === 1 ? <code key={i}>{part}</code> : part));
}

/**
 * A failed clone: the first line of `message` as the headline, the rest
 * (the fix, from `describeCloneFailure`) dimmed beneath it.
 */
export function CloneError({ message }: { message: string }) {
  const [title, ...rest] = message.split("\n");
  const detail = rest.join("\n").trim();
  return (
    <div className={styles.errorBox} role="alert">
      <CircleAlert size={14} className={styles.errorIcon} />
      <Stack gap="xs">
        <div className={styles.errorTitle}>{withInlineCode(title)}</div>
        {detail && <div className={styles.errorDetail}>{withInlineCode(detail)}</div>}
      </Stack>
    </div>
  );
}
