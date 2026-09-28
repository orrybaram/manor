import type { ReactNode } from "react";
import { ManorLogo } from "../ui/ManorLogo";
import { Row, Stack } from "../ui/Layout/Layout";
import { Button } from "../ui/Button/Button";
import styles from "../EmptyState.module.css";

export interface ActionItem {
  icon: ReactNode;
  label: string;
  keys: string[];
  action: () => void;
  variant?: "danger";
  /**
   * Set on rows whose availability resolves asynchronously: `true` reserves the
   * row's height without showing it, `false` fades it in. Leave undefined for
   * rows that are always present.
   */
  hidden?: boolean;
}

type EmptyStateShellProps = {
  subtitle?: string;
  actions: ActionItem[];
  /** Optional notice rendered above the shortcut list (e.g. the gh CLI nudge). */
  banner?: ReactNode;
  /** `data-testid` for the root, so e2e tests can tell the surfaces apart. */
  testId?: string;
  /**
   * Extra content rendered under the actions list, in the same 480px column
   * (ADR-194 §1: Home's Needs-you / Up next sections and summary line).
   */
  children?: ReactNode;
};

export function EmptyStateShell(props: EmptyStateShellProps) {
  const { subtitle, actions, banner, testId, children } = props;

  return (
    <Row
      align="center"
      justify="center"
      className={styles.container}
      data-testid={testId}
    >
      <Stack gap="3xl" className={styles.content}>
        <div className={styles.logo}>
          <ManorLogo />
          {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
        </div>
        {banner}
        <Stack gap="xs" className={styles.actions}>
          {actions.map((item) => (
            <Button
              key={item.label}
              variant="ghost"
              className={[
                styles.action,
                item.variant === "danger" ? styles.actionDanger : "",
                item.hidden === true ? styles.actionReserved : "",
                item.hidden === false ? styles.actionRevealed : "",
              ]
                .filter(Boolean)
                .join(" ")}
              onClick={() => item.action()}
              disabled={item.hidden === true}
              aria-hidden={item.hidden === true || undefined}
              tabIndex={item.hidden === true ? -1 : undefined}
            >
              <span className={styles.actionIcon}>{item.icon}</span>
              <span className={styles.actionLabel}>{item.label}</span>
              {item.keys.length > 0 && (
                <Row gap="xs">
                  {item.keys.map((key) => (
                    <kbd key={key} className={styles.kbd}>
                      {key}
                    </kbd>
                  ))}
                </Row>
              )}
            </Button>
          ))}
        </Stack>
        {children}
      </Stack>
    </Row>
  );
}
