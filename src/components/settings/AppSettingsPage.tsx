import { ThemeSection } from "./ThemeSection";
import { Stack } from "../ui/Layout/Layout";
import styles from "./SettingsModal/SettingsModal.module.css";

export function AppSettingsPage() {
  return (
    <Stack className={styles.pageContent}>
      <ThemeSection />

      <Stack gap="xs">
        <div className={styles.sectionTitle}>Font</div>
        <div className={styles.placeholder}>
          Font family and size settings coming soon.
        </div>
      </Stack>
    </Stack>
  );
}
