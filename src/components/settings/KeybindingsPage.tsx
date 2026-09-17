import { useState, useCallback, useEffect, useRef } from "react";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw";
import Check from "lucide-react/dist/esm/icons/check";
import X from "lucide-react/dist/esm/icons/x";
import { useKeybindingsStore } from "../../store/keybindings-store";
import { Button } from "../ui/Button/Button";
import { Input } from "../ui/Input";
import { Stack, Row } from "../ui/Layout/Layout";
import {
  DEFAULT_KEYBINDINGS,
  KeyCombo,
  comboFromEvent,
  comboMatches,
  formatCombo,
  isBindableCombo,
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  KeybindingCategory,
} from "../../lib/keybindings";
import { SectionTitle } from "./SectionTitle";
import styles from "./SettingsModal/SettingsModal.module.css";

const platform = navigator.platform.toLowerCase().includes("mac")
  ? ("mac" as const)
  : ("other" as const);

function findConflict(
  combo: KeyCombo,
  excludeId: string,
  bindings: Record<string, KeyCombo>,
): { id: string; label: string } | null {
  for (const def of DEFAULT_KEYBINDINGS) {
    if (def.id === excludeId) continue;
    if (bindings[def.id] && comboMatches(combo, bindings[def.id])) {
      return { id: def.id, label: def.label };
    }
  }
  return null;
}

export function KeybindingsPage() {
  const [search, setSearch] = useState("");
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [recordedCombo, setRecordedCombo] = useState<KeyCombo | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);

  const bindings = useKeybindingsStore((s) => s.bindings);
  const overriddenIds = useKeybindingsStore((s) => s.overriddenIds);
  const store = useKeybindingsStore();

  const recordingIdRef = useRef(recordingId);
  recordingIdRef.current = recordingId;

  // The row's own "shortcut" button, keyed by command id, so recording can
  // hand focus back to the row that started it (ADR-175).
  const shortcutBtnRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  // The id recording just ended for, consumed by the effect below once the
  // row has re-rendered back into its non-recording state and the button
  // ref above is live again.
  const pendingFocusIdRef = useRef<string | null>(null);

  const filtered = search
    ? DEFAULT_KEYBINDINGS.filter((def) =>
        def.label.toLowerCase().includes(search.toLowerCase()),
      )
    : DEFAULT_KEYBINDINGS;

  const endRecording = useCallback((idToRestore: string | null) => {
    pendingFocusIdRef.current = idToRestore;
    setRecordingId(null);
    setRecordedCombo(null);
    setConflict(null);
  }, []);

  const cancelRecording = useCallback(() => {
    endRecording(recordingId);
  }, [recordingId, endRecording]);

  const confirmRecording = useCallback(() => {
    if (recordingId && recordedCombo) {
      store.set(recordingId, recordedCombo);
    }
    endRecording(recordingId);
  }, [recordingId, recordedCombo, store, endRecording]);

  // Runs once the row recording just ended for has re-rendered its button.
  useEffect(() => {
    if (recordingId !== null) return;
    const id = pendingFocusIdRef.current;
    if (!id) return;
    pendingFocusIdRef.current = null;
    shortcutBtnRefs.current.get(id)?.focus();
  }, [recordingId]);

  useEffect(() => {
    if (!recordingId) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Never captured: the browser keeps moving focus, so Tab (or
      // Shift+Tab) reaches the Confirm/Cancel buttons — or leaves the row
      // entirely — like it would anywhere else (ADR-175).
      if (e.key === "Tab") return;

      e.preventDefault();
      e.stopPropagation();

      if (e.key === "Escape") {
        cancelRecording();
      }
      // Everything else, including a modifier held on its own, is captured
      // on keyup below — that's the key (and modifiers still held at that
      // point) the user actually meant to record, not the down-stroke of
      // whichever one happened to land first.
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Tab" || e.key === "Escape") return;
      if (["Meta", "Control", "Shift", "Alt"].includes(e.key)) return;

      e.preventDefault();
      e.stopPropagation();

      const combo = comboFromEvent(e);

      // Bindings need ⌘, Ctrl or Alt, except a bare function key (ADR-175).
      if (!isBindableCombo(combo)) {
        setRecordedCombo(null);
        setConflict("Needs ⌘, Ctrl, Alt or an unmodified F1–F12");
        return;
      }

      const conflictResult = findConflict(combo, recordingId, bindings);
      setRecordedCombo(combo);
      setConflict(
        conflictResult ? `Already assigned to ${conflictResult.label}` : null,
      );
    };

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp, true);
    };
  }, [recordingId, bindings, cancelRecording]);

  return (
    <Stack className={styles.pageContent}>
      <Stack gap="xs">
        <SectionTitle id="keybindings-list">Keybindings</SectionTitle>
        <Input
          className={styles.keybindingsSearch}
          type="text"
          placeholder="Search keybindings..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        <Stack gap="lg">
          {CATEGORY_ORDER.map(
            (category: KeybindingCategory, categoryIndex: number) => {
              const categoryDefs = filtered.filter(
                (def) => def.category === category,
              );
              if (categoryDefs.length === 0) return null;

              return (
                <div key={category}>
                  <div
                    className={styles.keybindingCategory}
                    style={categoryIndex === 0 ? { marginTop: 0 } : undefined}
                  >
                    {CATEGORY_LABELS[category]}
                  </div>
                  {categoryDefs.map((def) => {
                    const isRecording = recordingId === def.id;
                    const isOverridden = overriddenIds.has(def.id);
                    const combo = bindings[def.id];

                    return (
                      <div
                        key={def.id}
                        className={`${styles.keybindingRow} ${isOverridden ? styles.keybindingModified : ""}`}
                      >
                        <span className={styles.keybindingLabel}>
                          {def.label}
                        </span>

                        {isRecording ? (
                          <Row align="center" gap="xs">
                            <span
                              className={`${styles.keybindingShortcut} ${styles.keybindingRecording}`}
                            >
                              {recordedCombo
                                ? formatCombo(recordedCombo, platform)
                                : "Press keys..."}
                            </span>
                            <Button
                              variant="ghost"
                              size="sm"
                              className={styles.keybindingActionBtn}
                              onClick={confirmRecording}
                              title="Confirm"
                              aria-label={`Confirm shortcut for ${def.label}`}
                              disabled={!recordedCombo || !!conflict}
                            >
                              <Check size={14} />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className={styles.keybindingActionBtn}
                              onClick={cancelRecording}
                              title="Cancel"
                              aria-label={`Cancel recording for ${def.label}`}
                            >
                              <X size={14} />
                            </Button>
                          </Row>
                        ) : (
                          <Row align="center" gap="xs">
                            <Button
                              ref={(el) => {
                                if (el) shortcutBtnRefs.current.set(def.id, el);
                                else shortcutBtnRefs.current.delete(def.id);
                              }}
                              variant="secondary"
                              size="sm"
                              className={styles.keybindingShortcut}
                              onClick={() => {
                                setRecordingId(def.id);
                                setRecordedCombo(null);
                                setConflict(null);
                              }}
                              title="Click to edit"
                              aria-label={`${def.label} shortcut: ${combo ? formatCombo(combo, platform) : "unassigned"}. Press to record a new one.`}
                            >
                              {combo ? formatCombo(combo, platform) : "—"}
                            </Button>
                            {isOverridden && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className={styles.keybindingActionBtn}
                                onClick={() => store.reset(def.id)}
                                title="Reset to default"
                                aria-label={`Reset ${def.label} to its default shortcut`}
                              >
                                <RotateCcw size={13} />
                              </Button>
                            )}
                          </Row>
                        )}

                        {isRecording && conflict && (
                          <span className={styles.keybindingConflict}>
                            {conflict}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            },
          )}
        </Stack>

        <Button
          variant="secondary"
          className={styles.keybindingResetAll}
          onClick={() => store.resetAll()}
        >
          Reset All Keybindings
        </Button>
      </Stack>
    </Stack>
  );
}
