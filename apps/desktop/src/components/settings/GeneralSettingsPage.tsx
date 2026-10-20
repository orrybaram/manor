import { useState } from "react";
import { usePreferencesStore } from "../../store/preferences-store";
import { isTerminalEditor } from "../../lib/editor";
import { Input } from "../ui/Input";
import { Switch } from "../ui/Switch/Switch";
import { Button } from "../ui/Button/Button";
import { ResetStatsDialog } from "../command-palette/ResetStatsDialog";
import { Stack } from "../ui/Layout/Layout";
import { SectionTitle } from "./SectionTitle";
import { SettingField, SettingRow } from "./SettingRow";
import styles from "./SettingsModal/SettingsModal.module.css";

export function GeneralSettingsPage() {
  const { preferences, set } = usePreferencesStore();
  const [resetStatsOpen, setResetStatsOpen] = useState(false);

  const handleEditorChange = (value: string) => {
    set("defaultEditor", value);
    set("editorIsTerminal", isTerminalEditor(value));
  };

  return (
    <Stack className={styles.pageContent}>
      <Stack gap="xs">
        <SectionTitle id="general-editor">Code Editor</SectionTitle>
        <SettingField
          label="Default editor command"
          hint="CLI command used to open workspaces. Leave empty to use the system default."
        >
          <Input
            type="text"
            placeholder="e.g. code, cursor, zed, nvim"
            value={preferences.defaultEditor}
            onChange={(e) => handleEditorChange(e.target.value)}
          />
        </SettingField>
        <SettingRow
          label="Open in terminal"
          hint="Enable for terminal-based editors like vim, nvim, or emacs. Opens a new terminal tab instead of launching an external window."
        >
          <Switch
            checked={preferences.editorIsTerminal}
            onCheckedChange={(checked) => set("editorIsTerminal", checked)}
          />
        </SettingRow>
      </Stack>
      <Stack gap="xs">
        <SectionTitle id="general-diff">Diff</SectionTitle>
        <SettingRow
          label="Open diff in new panel"
          hint="When enabled, the diff view opens in a new side-by-side panel instead of a tab in the current panel."
        >
          <Switch
            checked={preferences.diffOpensInNewPanel}
            onCheckedChange={(checked) => set("diffOpensInNewPanel", checked)}
          />
        </SettingRow>
      </Stack>
      <Stack gap="xs">
        <SectionTitle id="general-stats">Usage Stats</SectionTitle>
        <SettingRow
          label="Collect usage stats"
          hint="Counts prompts, tool calls, worktrees and agents killed. Never stores text. Stays on this device."
          action={
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setResetStatsOpen(true)}
            >
              Reset stats
            </Button>
          }
        >
          <Switch
            checked={preferences.statsEnabled}
            onCheckedChange={(checked) => set("statsEnabled", checked)}
          />
        </SettingRow>
      </Stack>
      <Stack gap="xs">
        <SectionTitle id="general-folder-suggestions">
          Folder Suggestions
        </SectionTitle>
        <SettingRow
          label="Suggest folders for new workspaces"
          hint="Uses Jev, provided by Manor. Sends the workspace name, branch, agent prompt and your folder and workspace names to relay.manor.sh and TypeSafe. Nothing is stored."
        >
          <Switch
            checked={preferences.folderSuggestionsEnabled}
            onCheckedChange={(checked) =>
              set("folderSuggestionsEnabled", checked)
            }
          />
        </SettingRow>
      </Stack>
      <ResetStatsDialog
        open={resetStatsOpen}
        onOpenChange={setResetStatsOpen}
      />
    </Stack>
  );
}
