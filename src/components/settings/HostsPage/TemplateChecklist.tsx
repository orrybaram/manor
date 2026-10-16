import CheckCircle2 from "lucide-react/dist/esm/icons/check-circle-2";
import AlertCircle from "lucide-react/dist/esm/icons/alert-circle";
import CircleDashed from "lucide-react/dist/esm/icons/circle-dashed";
import Loader2 from "lucide-react/dist/esm/icons/loader-2";
import type { TemplateCheck } from "../../../electron.d";
import { Button } from "../../ui/Button/Button";
import { Link } from "../../ui/Link/Link";
import styles from "./TemplateChecklist.module.css";

type TemplateChecklistProps = {
  /** Null until the first check answers. */
  checks: TemplateCheck[] | null;
  /** The test id of the fix being carried out, if any. */
  fixing: string | null;
  disabled: boolean;
  /** A `run` or `set` fix was clicked. A `url` fix is a link and needs no handler. */
  onFix: (check: TemplateCheck) => void;
};

/** The test id of a check's fix: a `run` fix's own id, else the check's. */
function fixTestId(check: TemplateCheck): string {
  return check.fix?.kind === "run" ? check.fix.id : check.id;
}

function CheckIcon(props: { state: TemplateCheck["state"] }) {
  const { state } = props;

  if (state === "ok") return <CheckCircle2 size={15} className={`${styles.icon} ${styles.ok}`} aria-hidden />;
  if (state === "bad") return <AlertCircle size={15} className={`${styles.icon} ${styles.bad}`} aria-hidden />;
  if (state === "busy") return <Loader2 size={15} className={`${styles.icon} ${styles.busy}`} aria-hidden />;
  return <CircleDashed size={15} className={`${styles.icon} ${styles.todo}`} aria-hidden />;
}

const STATE_LABEL: Record<TemplateCheck["state"], string> = {
  ok: "Done",
  bad: "Needs attention",
  todo: "Not checked yet",
  busy: "In progress",
};

/**
 * A template's readiness checklist (ADR-234 D7, D8): one row per check, its
 * state as an icon, a plain title, a dim detail, and at most one fix on the
 * right — a button for one Manor carries out or a field it sets, a link for
 * a page to open.
 */
export function TemplateChecklist(props: TemplateChecklistProps) {
  const { checks, fixing, disabled, onFix } = props;

  if (checks === null) {
    return (
      <div className={styles.loading} data-testid="start-host-checks-loading">
        <Loader2 size={13} className={styles.busy} aria-hidden />
        Checking what's needed…
      </div>
    );
  }
  if (checks.length === 0) return null;

  return (
    <ul className={styles.list} aria-label="What's needed" data-testid="start-host-checks">
      {checks.map((check) => (
        <li
          key={check.id}
          className={`${styles.item} ${check.state === "todo" ? styles.itemTodo : ""}`}
          data-testid={`start-host-check-${check.id}`}
          data-state={check.state}
        >
          <CheckIcon state={check.state} />
          <span className="sr-only">{STATE_LABEL[check.state]}: </span>
          <div className={styles.text}>
            <div className={styles.title}>{check.title}</div>
            {check.detail && (
              <div className={styles.detail} title={check.detail}>
                {check.detail}
              </div>
            )}
          </div>
          {check.fix && check.state !== "ok" && <Fix check={check} fixing={fixing} disabled={disabled} onFix={onFix} />}
        </li>
      ))}
    </ul>
  );
}

type FixProps = {
  check: TemplateCheck;
  fixing: string | null;
  disabled: boolean;
  onFix: (check: TemplateCheck) => void;
};

function Fix(props: FixProps) {
  const { check, fixing, disabled, onFix } = props;

  const fix = check.fix;
  if (!fix) return null;
  const testId = fixTestId(check);

  if (fix.kind === "url") {
    return (
      <Link
        href={fix.href}
        variant="plain"
        className={styles.fixLink}
        data-testid={`start-host-fix-${testId}`}
      >
        {fix.label}
      </Link>
    );
  }
  const running = fixing === testId;
  return (
    <Button
      variant="secondary"
      size="sm"
      className={styles.fixButton}
      disabled={disabled || fixing !== null}
      onClick={() => onFix(check)}
      data-testid={`start-host-fix-${testId}`}
    >
      {running && <Loader2 size={12} className={styles.busy} aria-hidden />}
      {fix.label}
    </Button>
  );
}
