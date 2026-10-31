import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import Minus from "lucide-react/dist/esm/icons/minus";
import Plus from "lucide-react/dist/esm/icons/plus";
import { useMountEffect } from "../../../hooks/useMountEffect";
import { resolveTerminalFont } from "../../../hooks/useTerminalFont";
import { listMonospaceFonts } from "../../../lib/local-fonts";
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

/**
 * Settings › Font: a row per surface with a family picker, a size stepper and
 * a sample drawn in the result. The desktop's choice only: a phone or browser
 * tab draws with the bundled fonts (`useTerminalFont`).
 */
export function FontSection() {
  const preferences = usePreferencesStore((s) => s.preferences);
  const set = usePreferencesStore((s) => s.set);
  const theme = useThemeStore((s) => s.theme);
  const [installed, setInstalled] = useState<string[] | null>(null);

  useMountEffect(() => {
    if (isWebApp()) return;
    let live = true;
    listMonospaceFonts()
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

  const terminal = resolveTerminalFont(
    preferences.terminalFontFamily,
    preferences.terminalFontSize,
    false,
  );

  return (
    <Stack gap="xs">
      <SectionTitle id="app-font">Font</SectionTitle>
      <FontRow
        id="terminal-font"
        label="Terminal"
        hint="Nerd Font icons the chosen font lacks still draw from the bundled Meslo."
        defaultLabel="Default (MesloLGM Nerd Font)"
        family={preferences.terminalFontFamily}
        size={terminal.size}
        installed={installed}
        onFamily={(family) => set("terminalFontFamily", family)}
        onSize={(size) => set("terminalFontSize", size)}
        sampleStyle={{
          fontFamily: terminal.family,
          fontSize: terminal.size,
          background: theme?.background,
          color: theme?.foreground,
        }}
      >
        <span style={{ color: theme?.green }}>you@mac</span>{" "}
        <span style={{ color: theme?.blue }}>~/Code/manor</span>{" "}
        <span style={{ color: theme?.magenta }}>main</span>
        {"\n$ pnpm test\n"}
        <span style={{ color: theme?.brightBlack }}> ✓ 412 passed  →  </span>
      </FontRow>
    </Stack>
  );
}

type FontRowProps = {
  id: string;
  label: string;
  hint: string;
  defaultLabel: string;
  /** The stored family; empty means the default. */
  family: string;
  size: number;
  /** Installed monospace families; null while they load. */
  installed: string[] | null;
  onFamily: (family: string) => void;
  onSize: (size: number) => void;
  sampleStyle: CSSProperties;
  children: ReactNode;
};

/** One surface's font: label, family picker and size stepper, then a sample. */
function FontRow(props: FontRowProps) {
  const { id, label, hint, defaultLabel, family, size, installed } = props;

  const options = useMemo<SearchableSelectOption[]>(() => {
    const families = installed ?? [];
    // A saved family that is not installed (removed since, or the list is
    // still loading) stays visible as the selection rather than a blank.
    const listed =
      family && !families.includes(family) ? [family, ...families] : families;
    return [
      { value: "", label: defaultLabel },
      ...listed.map((name) => ({
        value: name,
        label: name,
        hint: families.includes(name) ? undefined : "Not installed",
      })),
    ];
  }, [installed, family, defaultLabel]);

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
            loading={installed === null}
            aria-label={`${label} font family`}
            searchPlaceholder="Search fonts..."
            emptyMessage="No installed font matches"
            maxWidth={220}
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
      <pre
        className={styles.sample}
        style={props.sampleStyle}
        data-testid={`${id}-sample`}
      >
        {props.children}
      </pre>
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
