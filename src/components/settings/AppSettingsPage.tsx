import { usePreferencesStore } from "../../store/preferences-store";
import { ThemeSection } from "./ThemeSection";
import { Input } from "@/components/ui/Input";
import styles from "./SettingsModal/SettingsModal.module.css";

export function AppSettingsPage() {
  const { preferences, set } = usePreferencesStore();

  return (
    <div className={styles.pageContent}>
      <ThemeSection />

      <div className={styles.settingsGroup}>
        <div className={styles.sectionTitle}>Editor</div>
        <div className={styles.fieldLabel}>Default editor command</div>
        <Input
          type="text"
          placeholder="e.g. code, cursor, zed"
          value={preferences.defaultEditor}
          onChange={(e) => set("defaultEditor", e.target.value)}
        />
        <div className={styles.fieldHint}>
          CLI command used to open workspaces. Leave empty to use the system
          default.
        </div>
      </div>

      <div className={styles.settingsGroup}>
        <div className={styles.sectionTitle}>Font</div>
        <div className={styles.placeholder}>
          Font family and size settings coming soon.
        </div>
      </div>
    </div>
  );
}
