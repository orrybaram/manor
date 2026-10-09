import type { ReactNode } from "react";
import styles from "./SettingsModal/SettingsModal.module.css";

type SettingRowProps = {
  label: ReactNode;
  /** Explains the setting; sits under the label, inside the row's divider. */
  hint?: ReactNode;
  /** The control, e.g. a `<Switch>`. Clicking the label text toggles it. */
  children: ReactNode;
  /**
   * A button that belongs to this setting, shown under the hint. Kept out of
   * the `<label>`: a button inside it would take the label's clicks.
   */
  action?: ReactNode;
};

/** One setting: label and hint on the left, its control on the right. */
export function SettingRow(props: SettingRowProps) {
  const { label, hint, children, action } = props;
  return (
    <div className={styles.settingRow}>
      <label className={styles.settingMain}>
        <span className={styles.settingText}>
          <span className={styles.settingLabel}>{label}</span>
          {hint && <span className={styles.settingHint}>{hint}</span>}
        </span>
        {children}
      </label>
      {action && <div className={styles.settingAction}>{action}</div>}
    </div>
  );
}

type SettingFieldProps = {
  label: ReactNode;
  hint?: ReactNode;
  /** The input. */
  children: ReactNode;
};

/** A setting whose control is a full-width field: label, field, then hint. */
export function SettingField(props: SettingFieldProps) {
  const { label, hint, children } = props;
  return (
    <label className={`${styles.settingRow} ${styles.settingField}`}>
      <span className={styles.settingLabel}>{label}</span>
      {children}
      {hint && <span className={styles.settingHint}>{hint}</span>}
    </label>
  );
}
