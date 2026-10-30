import { useRef, useState } from "react";
import { applyCssVars, useThemeStore, type Theme } from "../../../store/theme-store";
import { Button } from "../../ui/Button/Button";
import { ConfirmDialog } from "../../ui/ConfirmDialog/ConfirmDialog";
import { Input } from "../../ui/Input";
import styles from "./ThemePicker.module.css";

type ColorKey = Exclude<keyof Theme, "accent"> | "accent";

const BASE: { key: ColorKey; label: string }[] = [
  { key: "background", label: "Background" },
  { key: "foreground", label: "Text" },
  { key: "accent", label: "Accent" },
  { key: "cursor", label: "Cursor" },
  { key: "cursorAccent", label: "Cursor text" },
  { key: "selectionBackground", label: "Selection" },
  { key: "selectionForeground", label: "Selected text" },
];

const ANSI_NAMES = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const;
const NORMAL = ANSI_NAMES.map((n) => ({ key: n as ColorKey, label: n }));
const BRIGHT = ANSI_NAMES.map((n) => ({
  key: `bright${n[0].toUpperCase()}${n.slice(1)}` as ColorKey,
  label: `bright ${n}`,
}));

type ThemeEditorProps = {
  /** Where the draft starts: a copy of the theme on screen, or the saved one. */
  initial: Theme;
  initialName: string;
  /** The custom theme being edited (its file name); absent for a new one. */
  editing?: string;
  /** Save worked; `selection` is the saved theme's selection name. */
  onSaved: (selection: string) => void;
  onDeleted: () => void;
  onCancel: () => void;
};

/**
 * A custom theme's colours. Every change repaints the whole app, terminals
 * included, so you judge a colour where it'll be used; Cancel puts the theme
 * that was showing back. Closing Settings mid-edit does the same through the
 * modal's own restore.
 */
export function ThemeEditor(props: ThemeEditorProps) {
  const { initial, initialName, editing, onSaved, onDeleted, onCancel } = props;
  const [draft, setDraft] = useState<Theme>(() => ({
    ...initial,
    accent: initial.accent ?? initial.blue,
  }));
  const [name, setName] = useState(initialName);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // The theme showing before the edit, to put back on Cancel.
  const shownBefore = useRef(useThemeStore.getState().theme);
  const frame = useRef(0);

  const repaint = (theme: Theme) => {
    // A colour input fires on every drag step; paint once per frame.
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      useThemeStore.setState({ theme });
      applyCssVars(theme);
    });
  };

  const setColor = (key: ColorKey, value: string) => {
    const next = { ...draft, [key]: value };
    setDraft(next);
    repaint(next);
  };

  const cancel = () => {
    cancelAnimationFrame(frame.current);
    const before = shownBefore.current;
    if (before) {
      useThemeStore.setState({ theme: before });
      applyCssVars(before);
    }
    onCancel();
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const selection = await window.electronAPI.theme.saveCustom(name, draft, editing);
      onSaved(selection);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const swatch = ({ key, label }: { key: ColorKey; label: string }, showLabel: boolean) => (
    <div className={styles.swatch} key={key} title={showLabel ? undefined : label}>
      <label className={styles.swatchColor} style={{ background: draft[key] }}>
        <input
          type="color"
          value={draft[key]}
          onChange={(e) => setColor(key, e.target.value)}
          aria-label={label}
          data-testid={`theme-color-${key}`}
        />
      </label>
      {showLabel && label}
    </div>
  );

  return (
    <div className={styles.editor} data-testid="theme-editor">
      <Preview theme={draft} />
      <div className={styles.fields}>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="Theme name"
          placeholder="Theme name"
          maxLength={64}
          autoFocus
          data-testid="theme-name"
        />
        <div>
          <div className={styles.groupLabel}>Base</div>
          <div className={styles.swatches}>{BASE.map((s) => swatch(s, true))}</div>
        </div>
        <div>
          <div className={styles.groupLabel}>Normal · Bright</div>
          <div className={styles.ansi}>
            {NORMAL.map((s) => swatch(s, false))}
            {BRIGHT.map((s) => swatch(s, false))}
          </div>
        </div>
        {error && <div className={styles.error}>{error}</div>}
        <div className={styles.footer}>
          {editing && (
            <Button variant="danger" size="sm" onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
          )}
          <span className={styles.footerSpacer} />
          <Button size="sm" onClick={cancel}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={save}
            disabled={saving || !name.trim()}
            data-testid="theme-save"
          >
            Save
          </Button>
        </div>
      </div>
      {editing && (
        <ConfirmDialog
          open={confirmDelete}
          title={`Delete "${editing}"?`}
          description="Its file in ~/.manor/themes is deleted. If it's your theme now, Manor goes back to the default."
          confirmLabel="Delete"
          confirmVariant="danger"
          onConfirm={async () => {
            await window.electronAPI.theme.deleteCustom(editing);
            setConfirmDelete(false);
            onDeleted();
          }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </div>
  );
}

/** A few terminal lines in the draft's colours. */
function Preview({ theme }: { theme: Theme }) {
  const c = (color: string, text: string) => <span style={{ color }}>{text}</span>;
  return (
    <div
      className={styles.preview}
      style={{ background: theme.background, color: theme.foreground }}
      aria-hidden
    >
      {c(theme.green, "~/manor")} {c(theme.accent ?? theme.blue, "main")} $ pnpm test{"\n"}
      {c(theme.green, "✓")} 412 passed  {c(theme.red, "✗ 1 failed")}{"\n"}
      {c(theme.magenta, "claude")} {c(theme.yellow, "› editing theme.ts")}{"\n"}
      {c(theme.brightBlack, "# wake the house")}{"\n"}
      {c(theme.cyan, "const")} {c(theme.blue, "manor")} = {c(theme.yellow, '"haunted"')};{"\n"}
      <span style={{ background: theme.selectionBackground, color: theme.selectionForeground }}>
        selected text
      </span>{" "}
      <span style={{ background: theme.cursor, color: theme.cursorAccent }}>_</span>
    </div>
  );
}

function errorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  // IPC wraps the handler's error: keep only what the handler said.
  return message.replace(/^.*?Error: /, "");
}
