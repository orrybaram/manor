import { useCallback, useEffect, useRef, useState } from "react";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import {
  PROMPT_DEFINITIONS,
  PROMPT_MAX_CHARS,
  promptDefinition,
  promptProblems,
  promptTemplate,
  type PromptDefinition,
  type PromptId,
} from "../../../lib/prompts/catalog";
import { usePreferencesStore } from "../../../store/preferences-store";
import { Button } from "../../ui/Button/Button";
import { Textarea } from "../../ui/Input";
import { SectionTitle } from "../SectionTitle";
import styles from "./PromptsPage.module.css";

/** How long typing rests before an edit saves. */
const SAVE_AFTER_MS = 400;

const GROUPS = [...new Set(PROMPT_DEFINITIONS.map((d) => d.group))];

/** Settings › Prompts: what Manor tells agents, as cards opening an editor. */
export function PromptsPage() {
  const [open, setOpen] = useState<PromptId | null>(null);
  if (open) return <PromptEditor key={open} id={open} onBack={() => setOpen(null)} />;
  return <PromptList onOpen={setOpen} />;
}

function PromptList(props: { onOpen: (id: PromptId) => void }) {
  const overrides = usePreferencesStore((s) => s.preferences.promptOverrides);
  return (
    <div className={styles.page} data-testid="prompts-list">
      <div className={styles.intro}>
        <SectionTitle id="prompts-list">Prompts</SectionTitle>
        <div className={styles.description}>
          What Manor sends to agents when you start or brief them. Edits apply everywhere, including
          remote hosts.
        </div>
      </div>
      {GROUPS.map((group) => (
        <div key={group} className={styles.group}>
          <div className={styles.groupTitle}>{group}</div>
          <div className={styles.cards}>
            {PROMPT_DEFINITIONS.filter((d) => d.group === group).map((definition) => (
              <PromptCard
                key={definition.id}
                definition={definition}
                text={promptTemplate(definition.id, overrides)}
                edited={typeof overrides?.[definition.id] === "string"}
                onOpen={() => props.onOpen(definition.id)}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function PromptCard(props: {
  definition: PromptDefinition;
  text: string;
  edited: boolean;
  onOpen: () => void;
}) {
  const { definition, text, edited, onOpen } = props;
  return (
    <button
      type="button"
      className={styles.card}
      data-testid={`prompt-card-${definition.id}`}
      onClick={onOpen}
    >
      <span className={styles.cardHead}>
        <span className={styles.cardName}>{definition.label}</span>
        {edited && <span className={styles.edited}>Edited</span>}
        <ChevronRight size={14} className={styles.chevron} />
      </span>
      <span className={styles.cardText}>{text.trim() || "Sends nothing"}</span>
    </button>
  );
}

/** What's wrong with `text`, most serious first; `blocks` means it isn't saved. */
function editorNotes(id: PromptId, text: string): { blocks: boolean; notes: string[] } {
  const { empty, tooLong, unknown, missing } = promptProblems(id, text);
  if (empty) return { blocks: true, notes: ["This prompt can't be blank. Your last saved text stays."] };
  if (tooLong) {
    return {
      blocks: true,
      notes: [`This is over the ${PROMPT_MAX_CHARS.toLocaleString()} character limit, so it isn't saved.`],
    };
  }
  const named = (names: string[]) => names.map((name) => `{{${name}}}`).join(", ");
  const notes: string[] = [];
  if (!text.trim()) notes.push("Agents will get no hint.");
  if (unknown.length > 0) {
    notes.push(
      `${named(unknown)} ${unknown.length === 1 ? "isn't a placeholder" : "aren't placeholders"} here, so agents get ${unknown.length === 1 ? "it" : "them"} as typed.`,
    );
  }
  if (missing.length > 0) notes.push(`Agents won't get ${named(missing)}.`);
  return { blocks: false, notes };
}

function PromptEditor(props: { id: PromptId; onBack: () => void }) {
  const { id, onBack } = props;
  const definition = promptDefinition(id);
  const saved = usePreferencesStore((s) => s.preferences.promptOverrides?.[id]);
  const [text, setText] = useState(() => (typeof saved === "string" ? saved : definition.template));
  const [saveError, setSaveError] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);

  // The edit waiting on `SAVE_AFTER_MS`, so leaving the page can't lose it.
  const pending = useRef<{ timer: ReturnType<typeof setTimeout>; text: string } | null>(null);

  const save = useCallback(
    (next: string | null) => {
      window.electronAPI.preferences.setPrompt(id, next).then(
        () => setSaveError(null),
        () => setSaveError("Couldn't save this prompt. Try again."),
      );
    },
    [id],
  );

  const flush = useCallback(() => {
    if (!pending.current) return;
    clearTimeout(pending.current.timer);
    const { text: next } = pending.current;
    pending.current = null;
    save(next);
  }, [save]);

  useEffect(() => flush, [flush]);

  const change = (next: string) => {
    setText(next);
    if (pending.current) clearTimeout(pending.current.timer);
    pending.current = null;
    if (editorNotes(id, next).blocks) return;
    pending.current = { timer: setTimeout(flush, SAVE_AFTER_MS), text: next };
  };

  const insert = (name: string) => {
    const field = area.current;
    const token = `{{${name}}}`;
    const start = field?.selectionStart ?? text.length;
    const end = field?.selectionEnd ?? text.length;
    change(text.slice(0, start) + token + text.slice(end));
    requestAnimationFrame(() => {
      field?.focus();
      field?.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const reset = () => {
    if (pending.current) clearTimeout(pending.current.timer);
    pending.current = null;
    setText(definition.template);
    save(null);
  };

  const { notes, blocks } = editorNotes(id, text);
  const isDefault = text === definition.template && typeof saved !== "string";
  const placeholders = Object.entries(definition.placeholders);

  return (
    <div className={styles.editor} data-testid="prompt-editor">
      <Button variant="ghost" size="sm" className={styles.back} data-testid="prompt-back" onClick={onBack}>
        ‹ Prompts
      </Button>
      <div className={styles.editorHead}>
        <div className={styles.editorName}>{definition.label}</div>
        <div className={styles.description}>{definition.usedWhen}</div>
      </div>
      <Textarea
        ref={area}
        className={styles.text}
        value={text}
        spellCheck={false}
        aria-label={`${definition.label} text`}
        aria-invalid={blocks}
        data-testid="prompt-text"
        onChange={(e) => change(e.target.value)}
        onBlur={flush}
      />
      {placeholders.length > 0 && (
        <div className={styles.placeholders}>
          <div className={styles.groupTitle}>Placeholders</div>
          <div className={styles.placeholderList}>
            {placeholders.map(([name, description]) => (
              <button
                type="button"
                key={name}
                className={styles.placeholder}
                data-testid={`prompt-placeholder-${name}`}
                onClick={() => insert(name)}
              >
                <code className={styles.token}>{`{{${name}}}`}</code>
                <span className={styles.placeholderText}>{description}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      <div className={styles.footer}>
        <div className={styles.notes} data-testid="prompt-notes">
          {notes.map((note) => (
            <div key={note} className={blocks ? styles.error : styles.note} role={blocks ? "alert" : undefined}>
              {note}
            </div>
          ))}
          {saveError && (
            <div className={styles.error} role="alert">
              {saveError}
            </div>
          )}
        </div>
        <Button
          variant="secondary"
          size="sm"
          disabled={isDefault}
          data-testid="prompt-reset"
          onClick={reset}
        >
          Reset to default
        </Button>
      </div>
    </div>
  );
}
