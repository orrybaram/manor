import type { ReactNode } from "react";
import { ManorLogo } from "../ui/ManorLogo";
import { Row, Stack } from "../ui/Layout/Layout";
import styles from "../EmptyState.module.css";

export interface ActionItem {
  icon: ReactNode;
  label: string;
  keys: string[];
  action: () => void;
  variant?: "danger";
}

type EmptyStateShellProps = {
  subtitle?: string;
  actions: ActionItem[];
  ticketsSection?: ReactNode;
};

export function EmptyStateShell(props: EmptyStateShellProps) {
  const { subtitle, actions, ticketsSection } = props;

  return (
    <Row align="center" justify="center" className={styles.container}>
      <Stack gap="3xl" className={styles.content}>
        <div className={styles.logo}>
          <ManorLogo />
          {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
        </div>
        {ticketsSection}
        <Stack gap="xs" className={styles.actions}>
          {actions.map((item) => (
            <button
              key={item.label}
              className={`${styles.action} ${item.variant === "danger" ? styles.actionDanger : ""}`}
              onClick={item.action}
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
            </button>
          ))}
        </Stack>
      </Stack>
    </Row>
  );
}
