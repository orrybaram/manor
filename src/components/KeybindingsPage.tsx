import { useState, useCallback, useEffect, useRef } from "react";
import { RotateCcw, Check, X } from "lucide-react";
import { useKeybindingsStore } from "../store/keybindings-store";
import {
  DEFAULT_KEYBINDINGS,
  KeyCombo,
  comboFromEvent,
  comboMatches,
  formatCombo,
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  KeybindingCategory,
} from "../lib/keybindings";
import styles from "./SettingsModal.module.css";

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

  const filtered = search
    ? DEFAULT_KEYBINDINGS.filter((def) =>
        def.label.toLowerCase().includes(search.toLowerCase()),
      )
    : DEFAULT_KEYBINDINGS;

  const cancelRecording = useCallback(() => {
    setRecordingId(null);
    setRecordedCombo(null);
    setConflict(null);
  }, []);

  const confirmRecording = useCallback(() => {
    if (recordingId && recordedCombo) {
      store.set(recordingId, recordedCombo);
    }
    cancelRecording();
  }, [recordingId, recordedCombo, store, cancelRecording]);

  useEffect(() => {
    if (!recordingId) return;

    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === "Escape") {
        cancelRecording();
        return;
      }

      // Ignore modifier-only presses
      if (["Meta", "Control", "Shift", "Alt"].includes(e.key)) return;

      const combo = comboFromEvent(e);
      const conflictResult = findConflict(combo, recordingId, bindings);
      setRecordedCombo(combo);
      setConflict(conflictResult ? `Already assigned to ${conflictResult.label}` : null);
    };

    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [recordingId, bindings, cancelRecording]);

  return (
    <div className={styles.pageContent}>
      <div className={styles.settingsGroup}>
        <div className={styles.sectionTitle}>Keybindings</div>
        <input
          className={styles.keybindingsSearch}
          type="text"
          placeholder="Search keybindings..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        <div className={styles.keybindingsList}>
          {CATEGORY_ORDER.map((category: KeybindingCategory, categoryIndex: number) => {
            const categoryDefs = filtered.filter((def) => def.category === category);
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
                      <span className={styles.keybindingLabel}>{def.label}</span>

                      {isRecording ? (
                        <div className={styles.keybindingActions}>
                          <span
                            className={`${styles.keybindingShortcut} ${styles.keybindingRecording}`}
                          >
                            {recordedCombo
                              ? formatCombo(recordedCombo, platform)
                              : "Press keys..."}
                          </span>
                          <button
                            className={styles.keybindingActionBtn}
                            onClick={confirmRecording}
                            title="Confirm"
                            disabled={!recordedCombo || !!conflict}
                          >
                            <Check size={14} />
                          </button>
                          <button
                            className={styles.keybindingActionBtn}
                            onClick={cancelRecording}
                            title="Cancel"
                          >
                            <X size={14} />
                          </button>
                        </div>
                      ) : (
                        <div className={styles.keybindingActions}>
                          <button
                            className={styles.keybindingShortcut}
                            onClick={() => {
                              setRecordingId(def.id);
                              setRecordedCombo(null);
                              setConflict(null);
                            }}
                            title="Click to edit"
                          >
                            {combo ? formatCombo(combo, platform) : "—"}
                          </button>
                          {isOverridden && (
                            <button
                              className={styles.keybindingActionBtn}
                              onClick={() => store.reset(def.id)}
                              title="Reset to default"
                            >
                              <RotateCcw size={13} />
                            </button>
                          )}
                        </div>
                      )}

                      {isRecording && conflict && (
                        <span className={styles.keybindingConflict}>{conflict}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

        <button
          className={styles.keybindingResetAll}
          onClick={() => store.resetAll()}
        >
          Reset All Keybindings
        </button>
      </div>
    </div>
  );
}
