import { usePreferencesStore } from "../../store/preferences-store";
import { isTerminalEditor } from "../../lib/editor";
import { Input } from "../ui/Input";
import { Switch } from "../ui/Switch/Switch";
import { Stack } from "../ui/Layout/Layout";
import styles from "./SettingsModal/SettingsModal.module.css";

export function GeneralSettingsPage() {
  const { preferences, set } = usePreferencesStore();

  const handleEditorChange = (value: string) => {
    set("defaultEditor", value);
    set("editorIsTerminal", isTerminalEditor(value));
  };

  return (
    <Stack className={styles.pageContent}>
      <Stack gap="xs">
        <div className={styles.sectionTitle}>Code Editor</div>
        <div className={styles.fieldLabel}>Default editor command</div>
        <Input
          type="text"
          placeholder="e.g. code, cursor, zed, nvim"
          value={preferences.defaultEditor}
          onChange={(e) => handleEditorChange(e.target.value)}
        />
        <div className={styles.fieldHint}>
          CLI command used to open workspaces. Leave empty to use the system
          default.
        </div>
        <label className={styles.notifRow}>
          <span>Open in terminal</span>
          <Switch
            checked={preferences.editorIsTerminal}
            onCheckedChange={(checked) => set("editorIsTerminal", checked)}
          />
        </label>
        <div className={styles.fieldHint}>
          Enable for terminal-based editors like vim, nvim, or emacs. Opens a
          new terminal tab instead of launching an external window.
        </div>
      </Stack>
    </Stack>
  );
}
