import { useState } from "react";
import { usePreferencesStore } from "../../store/preferences-store";
import { isTerminalEditor } from "../../lib/editor";
import { Input } from "../ui/Input";
import { Switch } from "../ui/Switch/Switch";
import { Button } from "../ui/Button/Button";
import { ToggleGroup } from "../ui/ToggleGroup";
import { ResetStatsDialog } from "../command-palette/ResetStatsDialog";
import { Stack } from "../ui/Layout/Layout";
import { SectionTitle } from "./SectionTitle";
import { SettingField, SettingRow } from "./SettingRow";
import styles from "./SettingsModal/SettingsModal.module.css";

type EditorKind = "manor" | "other";

const EDITOR_KINDS: { value: EditorKind; label: string }[] = [
  { value: "manor", label: "Manor" },
  { value: "other", label: "Other app" },
];

export function GeneralSettingsPage() {
  const { preferences, set } = usePreferencesStore();
  const [resetStatsOpen, setResetStatsOpen] = useState(false);
  // An empty command is Manor; "Other app" shows the command field even
  // before anything is typed in it.
  const [editorKind, setEditorKind] = useState<EditorKind>(
    preferences.defaultEditor.trim() ? "other" : "manor",
  );

  const handleEditorChange = (value: string) => {
    set("defaultEditor", value);
    set("editorIsTerminal", isTerminalEditor(value));
  };

  const handleEditorKindChange = (kind: EditorKind) => {
    setEditorKind(kind);
    if (kind === "manor") handleEditorChange("");
  };

  return (
    <Stack className={styles.pageContent}>
      <Stack gap="xs">
        <SectionTitle id="general-editor">Code Editor</SectionTitle>
        <SettingRow
          plain
          label="Default editor"
          hint={
            editorKind === "manor"
              ? "Workspace files open in a file pane, including Cmd+clicked paths in a terminal."
              : "Workspaces and Cmd+clicked file paths open in this app. Right-click a path to open it in a file pane."
          }
        >
          <ToggleGroup
            value={editorKind}
            onChange={handleEditorKindChange}
            options={EDITOR_KINDS}
            size="sm"
            aria-label="Default editor"
            data-testid="default-editor-kind"
          />
        </SettingRow>
        {editorKind === "other" && (
          <>
            <SettingField
              label="Editor command"
              hint="CLI command used to open workspaces and files. Leave empty to use Manor."
            >
              <Input
                type="text"
                placeholder="e.g. code, cursor, zed, nvim"
                value={preferences.defaultEditor}
                onChange={(e) => handleEditorChange(e.target.value)}
                data-testid="default-editor-command"
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
          </>
        )}
      </Stack>
      <Stack gap="xs">
        <SectionTitle id="general-diff">Source Control</SectionTitle>
        <SettingRow
          label="Open Source Control in new panel"
          hint="When enabled, Open Source Control opens a file pane in a new side-by-side panel instead of a tab in the current panel."
        >
          <Switch
            checked={preferences.diffOpensInNewPanel}
            onCheckedChange={(checked) => set("diffOpensInNewPanel", checked)}
          />
        </SettingRow>
      </Stack>
      <Stack gap="xs">
        <SectionTitle id="general-chat">Agent Chat</SectionTitle>
        <SettingRow
          label="Show agent panes as chat"
          hint="Agent panes open on the chat instead of the terminal. A pane you switch with its chat button keeps its own choice. The phone always opens on the chat."
        >
          <Switch
            checked={preferences.deskChatByDefault}
            onCheckedChange={(checked) => set("deskChatByDefault", checked)}
            data-testid="desk-chat-by-default"
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
