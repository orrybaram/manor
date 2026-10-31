import { ThemeSection } from "./ThemeSection";
import { FontSection } from "./FontSection/FontSection";
import { Stack } from "../ui/Layout/Layout";
import { Switch } from "../ui/Switch/Switch";
import { SectionTitle } from "./SectionTitle";
import { SettingRow } from "./SettingRow";
import { usePreferencesStore } from "../../store/preferences-store";
import styles from "./SettingsModal/SettingsModal.module.css";

export function AppSettingsPage() {
  const halloweenEffects = usePreferencesStore(
    (s) => s.preferences.halloweenEffects,
  );
  const set = usePreferencesStore((s) => s.set);

  return (
    <Stack className={styles.pageContent}>
      <ThemeSection />

      <FontSection />

      <Stack gap="xs">
        <SectionTitle id="app-seasonal">Seasonal</SectionTitle>
        <SettingRow
          label="Halloween effects"
          hint="From Oct 25 to Nov 1, tabs you haven't looked at gather dust, and their panels open under cobwebs you can sweep away with the mouse."
        >
          <Switch
            checked={halloweenEffects}
            onCheckedChange={(checked) => set("halloweenEffects", checked)}
          />
        </SettingRow>
      </Stack>
    </Stack>
  );
}
