import { ThemeSection } from "./ThemeSection";
import styles from "./SettingsModal.module.css";

export function AppSettingsPage() {
  return (
    <div className={styles.pageContent}>
      <ThemeSection />

      <div className={styles.settingsGroup}>
        <div className={styles.sectionTitle}>Font</div>
        <div className={styles.placeholder}>
          Font family and size settings coming soon.
        </div>
      </div>

      <div className={styles.settingsGroup}>
        <div className={styles.sectionTitle}>Keybindings</div>
        <div className={styles.placeholder}>
          Custom keyboard shortcuts coming soon.
        </div>
      </div>
    </div>
  );
}
