import { useMemo, useState, type ReactNode } from "react";
import Minus from "lucide-react/dist/esm/icons/minus";
import Plus from "lucide-react/dist/esm/icons/plus";
import { useMountEffect } from "../../../hooks/useMountEffect";
import { resolveTerminalFont } from "../../../hooks/useTerminalFont";
import { resolveEditorFont } from "../../../hooks/useEditorFont";
import { resolveChatFontSize } from "../../../hooks/useChatFont";
import { BUNDLED_CHAT_FONTS, chatFontStack } from "../../../lib/chat-fonts";
import { listInstalledFonts, listMonospaceFonts } from "../../../lib/local-fonts";
import { isWebApp } from "../../../lib/platform";
import { usePreferencesStore } from "../../../store/preferences-store";
import { useThemeStore } from "../../../store/theme-store";
import {
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
} from "../../../terminal/config";
import { Stack } from "../../ui/Layout/Layout";
import {
  SearchableSelect,
  type SearchableSelectOption,
} from "../../ui/SearchableSelect";
import { SectionTitle } from "../SectionTitle";
import settingsStyles from "../SettingsModal/SettingsModal.module.css";
import styles from "./FontSection.module.css";

const NO_BUNDLED_FONTS: readonly string[] = [];
const terminalStack = (family: string) =>
  resolveTerminalFont(family, undefined, false).family;
const editorStack = (family: string) =>
  resolveEditorFont(family, undefined).family;

/**
 * Settings › Font: a row per surface with a family picker, a size stepper and
 * a sample drawn in the result, every row built alike (`FontRow`). The desktop's choice: a phone or browser tab
 * draws its terminal and editor with the bundled fonts (`useTerminalFont`), and
 * follows only the chat family (`useChatFont`).
 */
export function FontSection() {
  const preferences = usePreferencesStore((s) => s.preferences);
  const set = usePreferencesStore((s) => s.set);
  const theme = useThemeStore((s) => s.theme);
  const [monospace, setMonospace] = useState<string[] | null>(null);
  const [installed, setInstalled] = useState<string[] | null>(null);

  useMountEffect(() => {
    if (isWebApp()) return;
    let live = true;
    listMonospaceFonts()
      .then((families) => live && setMonospace(families))
      .catch(() => live && setMonospace([]));
    listInstalledFonts()
      .then((families) => live && setInstalled(families))
      .catch(() => live && setInstalled([]));
    return () => {
      live = false;
    };
  });

  if (isWebApp()) {
    return (
      <Stack gap="xs">
        <SectionTitle id="app-font">Font</SectionTitle>
        <div className={settingsStyles.placeholder}>
          Fonts are set in Manor on each computer.
        </div>
      </Stack>
    );
  }

  const terminalSize = resolveTerminalFont(
    preferences.terminalFontFamily,
    preferences.terminalFontSize,
    false,
  ).size;
  const editorSize = resolveEditorFont(
    preferences.editorFontFamily,
    preferences.editorFontSize,
  ).size;
  const chatSize = resolveChatFontSize(preferences.chatFontSize);

  return (
    <Stack gap="xs">
      <SectionTitle id="app-font">Font</SectionTitle>
      <FontRow
        id="terminal-font"
        label="Terminal"
        hint="Nerd Font icons the chosen font lacks still draw from the bundled Meslo."
        defaultLabel="Default (MesloLGM Nerd Font)"
        family={preferences.terminalFontFamily}
        size={terminalSize}
        installed={monospace}
        stack={terminalStack}
        onFamily={(family) => set("terminalFontFamily", family)}
        onSize={(size) => set("terminalFontSize", size)}
        sample={(family) => (
          <pre
            className={styles.sample}
            style={{
              fontFamily: terminalStack(family),
              fontSize: terminalSize,
              background: theme?.background,
              color: theme?.foreground,
            }}
            data-testid="terminal-font-sample"
          >
            <span style={{ color: theme?.green }}>you@mac</span>{" "}
            <span style={{ color: theme?.blue }}>~/Code/manor</span>{" "}
            <span style={{ color: theme?.magenta }}>main</span>
            {"\n$ pnpm test\n"}
            <span style={{ color: theme?.brightBlack }}> ✓ 412 passed  →  </span>
          </pre>
        )}
      />
      <FontRow
        id="editor-font"
        label="Editor"
        hint="File and diff views."
        defaultLabel="Default (system monospace)"
        family={preferences.editorFontFamily}
        size={editorSize}
        installed={monospace}
        stack={editorStack}
        onFamily={(family) => set("editorFontFamily", family)}
        onSize={(size) => set("editorFontSize", size)}
        sample={(family) => (
          <pre
            className={styles.sample}
            style={{
              fontFamily: editorStack(family),
              fontSize: editorSize,
              background: "var(--bg)",
              color: "var(--fg)",
            }}
            data-testid="editor-font-sample"
          >
            <span style={{ color: "var(--magenta)" }}>export function</span>{" "}
            <span style={{ color: "var(--blue)" }}>terminalOptions</span>
            {"() {\n  "}
            <span style={{ color: "var(--magenta)" }}>return</span>
            {" { fontSize: "}
            <span style={{ color: "var(--yellow)" }}>13</span>
            {" };\n}"}
          </pre>
        )}
      />
      <FontRow
        id="chat-font"
        label="Chat"
        hint="Messages and the box you type in. A paired phone follows the font, not the size. Code stays monospace."
        defaultLabel="System"
        bundled={BUNDLED_CHAT_FONTS}
        family={preferences.chatFontFamily ?? ""}
        size={chatSize}
        installed={installed}
        stack={chatFontStack}
        onFamily={(family) => set("chatFontFamily", family)}
        onSize={(size) => set("chatFontSize", size)}
        sample={(family) => (
          <div
            className={styles.chatSample}
            style={{ fontFamily: chatFontStack(family), fontSize: chatSize }}
            data-testid="chat-font-sample"
          >
            <div className={styles.chatSampleUser}>
              Why did the phone keep reconnecting?
            </div>
            <div>
              The relay refused its old token, so it kept retrying. It now{" "}
              <b>relinks once</b> after a 4401, and the loop in{" "}
              <code className={styles.chatSampleCode}>relay-client.ts</code>{" "}
              never starts.
            </div>
          </div>
        )}
      />
    </Stack>
  );
}

type FontRowProps = {
  id: string;
  label: string;
  hint: string;
  defaultLabel: string;
  /** Families Manor ships for this surface, listed under the default. */
  bundled?: readonly string[];
  /** The stored family; empty means the default. */
  family: string;
  size: number;
  /** Installed families this surface can use; null while they load. */
  installed: string[] | null;
  /** The CSS font stack this surface draws a family in. */
  stack: (family: string) => string;
  onFamily: (family: string) => void;
  onSize: (size: number) => void;
  /** The sample, drawn in the family under the list's highlight, else the stored one. */
  sample: (family: string) => ReactNode;
};

/**
 * One surface's font: label, family picker and size stepper, then a sample.
 * The list has Manor's fonts above the installed ones, each drawn in its own
 * face, and the sample follows the highlight until the list closes.
 */
function FontRow(props: FontRowProps) {
  const { id, label, hint, defaultLabel, family, size, installed, stack } = props;
  const bundled = props.bundled ?? NO_BUNDLED_FONTS;
  const [highlighted, setHighlighted] = useState<string | null>(null);

  const options = useMemo<SearchableSelectOption[]>(() => {
    const families = (installed ?? []).filter((name) => !bundled.includes(name));
    // A saved family that is not installed (removed since, or the list is
    // still loading) stays visible as the selection rather than a blank.
    const missing =
      family && !bundled.includes(family) && !families.includes(family);
    const listed = missing ? [family, ...families] : families;
    return [
      { value: "", label: defaultLabel, group: "Manor", fontFamily: stack("") },
      ...bundled.map((name) => ({
        value: name,
        label: name,
        group: "Manor",
        fontFamily: stack(name),
      })),
      ...listed.map((name) => ({
        value: name,
        label: name,
        group: "Installed",
        fontFamily: stack(name),
        hint: families.includes(name) ? undefined : "Not installed",
      })),
    ];
  }, [installed, family, defaultLabel, bundled, stack]);

  return (
    <div className={settingsStyles.settingRow} data-testid={id}>
      <div className={styles.head}>
        <span className={settingsStyles.settingText}>
          <span className={settingsStyles.settingLabel}>{label}</span>
          <span className={settingsStyles.settingHint}>{hint}</span>
        </span>
        <div className={styles.controls}>
          <SearchableSelect
            value={family}
            onChange={props.onFamily}
            options={options}
            onHighlight={setHighlighted}
            triggerLabel={
              <span style={{ fontFamily: stack(family) }}>
                {family || defaultLabel}
              </span>
            }
            loading={installed === null}
            aria-label={`${label} font family`}
            searchPlaceholder="Search fonts..."
            emptyMessage="No installed font matches"
            maxWidth={250}
            className={styles.family}
            data-testid={`${id}-family`}
          />
          <SizeStepper
            label={label}
            size={size}
            onSize={props.onSize}
            testId={`${id}-size`}
          />
        </div>
      </div>
      {props.sample(highlighted ?? family)}
    </div>
  );
}

function SizeStepper(props: {
  label: string;
  size: number;
  onSize: (size: number) => void;
  testId: string;
}) {
  const { label, size, onSize } = props;
  return (
    <div className={styles.stepper} data-testid={props.testId}>
      <button
        type="button"
        className={styles.step}
        aria-label={`Smaller ${label.toLowerCase()} font`}
        disabled={size <= FONT_SIZE_MIN}
        onClick={() => onSize(size - 1)}
      >
        <Minus size={12} />
      </button>
      <output className={styles.size} aria-label={`${label} font size`}>
        {size} px
      </output>
      <button
        type="button"
        className={styles.step}
        aria-label={`Larger ${label.toLowerCase()} font`}
        disabled={size >= FONT_SIZE_MAX}
        onClick={() => onSize(size + 1)}
      >
        <Plus size={12} />
      </button>
    </div>
  );
}
