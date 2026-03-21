import type { ReactNode } from "react";
import { ManorLogo } from "./ManorLogo";
import styles from "./EmptyState.module.css";

export interface ActionItem {
  icon: ReactNode;
  label: string;
  keys: string[];
  action: () => void;
  variant?: "danger";
}

export function EmptyStateShell({
  subtitle,
  actions,
  ticketsSection,
}: {
  subtitle?: string;
  actions: ActionItem[];
  ticketsSection?: ReactNode;
}) {
  return (
    <div className={styles.container}>
      <div className={styles.content}>
        <div className={styles.logo}>
          <ManorLogo />
          {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
        </div>
        {ticketsSection}
        <div className={styles.actions}>
          {actions.map((item) => (
            <button
              key={item.label}
              className={`${styles.action} ${item.variant === "danger" ? styles.actionDanger : ""}`}
              onClick={item.action}
            >
              <span className={styles.actionIcon}>{item.icon}</span>
              <span className={styles.actionLabel}>{item.label}</span>
              {item.keys.length > 0 && (
                <span className={styles.actionKeys}>
                  {item.keys.map((key) => (
                    <kbd key={key} className={styles.kbd}>
                      {key}
                    </kbd>
                  ))}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
