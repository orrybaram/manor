import { Prec, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, keymap, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { isIdentifier } from "../definition-search";

/** Go to Definition (F12, ⌘-click) or Find Usages (⇧F12), for an identifier. */
export type CodeNavKind = "definition" | "usages";

export type CodeNavHandler = (kind: CodeNavKind, word: string) => void;

/** The identifier at `pos` (touching it), with where it is; null for anything else. */
export function identifierAt(
  state: EditorState,
  pos: number,
): { from: number; to: number; word: string } | null {
  const range = state.wordAt(pos);
  if (!range) return null;
  const word = state.sliceDoc(range.from, range.to);
  return isIdentifier(word) ? { from: range.from, to: range.to, word } : null;
}

/**
 * What F12 and ⇧F12 look up: the selection when it is one identifier, else
 * the identifier at the cursor.
 */
export function identifierAtCursor(state: EditorState): string | null {
  const { from, to, head } = state.selection.main;
  if (from !== to) {
    const selected = state.sliceDoc(from, to);
    return isIdentifier(selected) ? selected : null;
  }
  return identifierAt(state, head)?.word ?? null;
}

/** ⌘ alone on a Mac, Ctrl alone elsewhere: the key that makes a click Go to Definition. */
export function navModifier(
  e: Pick<MouseEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  mac: boolean,
): boolean {
  if (e.altKey || e.shiftKey) return false;
  return mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

/** The identifier under the pointer while the modifier is held, or null. */
const setNavLink = StateEffect.define<{ from: number; to: number } | null>();

const navLinkMark = Decoration.mark({ class: "cm-nav-link" });

const navLink = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let next = value.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setNavLink)) {
        next = effect.value
          ? Decoration.set([navLinkMark.range(effect.value.from, effect.value.to)])
          : Decoration.none;
      }
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const navLinkTheme = EditorView.baseTheme({
  ".cm-nav-link": {
    textDecoration: "underline",
    textUnderlineOffset: "2px",
    cursor: "pointer",
  },
});

/**
 * Holding the modifier underlines the identifier under the pointer, as a
 * link: tracked from the pointer's moves (which carry the modifier) and the
 * modifier's own presses anywhere in the window, and cleared when the
 * pointer leaves the editor or the window loses focus.
 */
function hoverLink(mac: boolean) {
  return ViewPlugin.fromClass(
    class {
      /** Where the pointer last was over the editor; null once it left. */
      pointer: { x: number; y: number } | null = null;
      shown: { from: number; to: number } | null = null;
      readonly onKey: (e: KeyboardEvent) => void;
      readonly onBlur: () => void;

      constructor(readonly view: EditorView) {
        this.onKey = (e) => this.refresh(navModifier(e, mac));
        this.onBlur = () => this.show(null);
        window.addEventListener("keydown", this.onKey, true);
        window.addEventListener("keyup", this.onKey, true);
        window.addEventListener("blur", this.onBlur);
      }

      update(update: ViewUpdate) {
        // Kept in step with the field, which a click (or a remap) also sets.
        for (const tr of update.transactions) {
          for (const effect of tr.effects) if (effect.is(setNavLink)) this.shown = effect.value;
        }
      }

      refresh(held: boolean) {
        if (!held || !this.pointer) {
          this.show(null);
          return;
        }
        const pos = this.view.posAtCoords(this.pointer);
        const word = pos === null ? null : identifierAt(this.view.state, pos);
        this.show(word && { from: word.from, to: word.to });
      }

      show(range: { from: number; to: number } | null) {
        const same =
          range === this.shown ||
          (range !== null &&
            this.shown !== null &&
            range.from === this.shown.from &&
            range.to === this.shown.to);
        if (same) return;
        // Not in the middle of another update: the key or pointer event's own turn.
        this.view.dispatch({ effects: setNavLink.of(range) });
      }

      destroy() {
        window.removeEventListener("keydown", this.onKey, true);
        window.removeEventListener("keyup", this.onKey, true);
        window.removeEventListener("blur", this.onBlur);
      }
    },
    {
      eventHandlers: {
        mousemove(e) {
          this.pointer = { x: e.clientX, y: e.clientY };
          this.refresh(navModifier(e, mac));
        },
        mouseleave() {
          this.pointer = null;
          this.show(null);
        },
      },
    },
  );
}

/**
 * Go to Definition and Find Usages in the editor: F12 and ⇧F12 on the
 * identifier at the cursor, and a ⌘-click (Ctrl-click off a Mac) on one,
 * with the identifier underlined while the modifier is held. A ⌘-click
 * anywhere but an identifier still adds a cursor, as CodeMirror's own does.
 * The keys stop at the editor, so an app binding on F12 doesn't also run.
 */
export function definitionNav(onNavigate: CodeNavHandler, mac: boolean): Extension {
  const byKey = (kind: CodeNavKind) => (view: EditorView) => {
    const word = identifierAtCursor(view.state);
    if (word) onNavigate(kind, word);
    return true;
  };
  return [
    navLink,
    navLinkTheme,
    hoverLink(mac),
    Prec.high(
      keymap.of([
        { key: "F12", run: byKey("definition"), stopPropagation: true },
        { key: "Shift-F12", run: byKey("usages"), stopPropagation: true },
      ]),
    ),
    // Ahead of CodeMirror's own mousedown, which would add a cursor.
    Prec.highest(
      EditorView.domEventHandlers({
        mousedown(e, view) {
          if (e.button !== 0 || !navModifier(e, mac)) return false;
          const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
          const word = pos === null ? null : identifierAt(view.state, pos);
          if (!word || pos === null) return false;
          e.preventDefault();
          view.dispatch({ selection: { anchor: pos }, effects: setNavLink.of(null) });
          view.focus();
          onNavigate("definition", word.word);
          return true;
        },
      }),
    ),
  ];
}
