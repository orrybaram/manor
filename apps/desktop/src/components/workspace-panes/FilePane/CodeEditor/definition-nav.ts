import { Prec, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  keymap,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { isIdentifier } from "../definition-search";

/** Go to Definition (F12, ⌘-click) or Find Usages (⇧F12), for an identifier. */
export type CodeNavKind = "definition" | "usages";

/** The editor the ask came from: put its cursor on a line of its own file, in place. */
export type CodeNavSource = {
  /** 1-based line and column. */
  goTo(line: number, col: number): void;
};

export type CodeNavHandler = (kind: CodeNavKind, word: string, source: CodeNavSource) => void;

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

/**
 * Whether `target` is the editor's own text: inside its content, and not in
 * a widget there (a comment card, a diff's deleted lines). The gutters, the
 * Find panel and the rest of its chrome are not.
 */
export function isCodeTarget(view: EditorView, target: EventTarget | null): boolean {
  if (!(target instanceof Node) || !view.contentDOM.contains(target)) return false;
  const el = target instanceof Element ? target : target.parentElement;
  const widget = el?.closest('[contenteditable="false"]');
  return !widget || !view.contentDOM.contains(widget);
}

/**
 * The identifier under the pointer at `x`, `y`, and its range: only when the
 * pointer is on its text, not in the blank past a line's end that the
 * nearest position would give.
 */
export function identifierUnder(
  view: EditorView,
  x: number,
  y: number,
): { from: number; to: number; word: string; pos: number } | null {
  const pos = view.posAtCoords({ x, y });
  if (pos === null) return null;
  const word = identifierAt(view.state, pos);
  if (!word) return null;
  const start = view.coordsAtPos(word.from, 1);
  const end = view.coordsAtPos(word.to, -1);
  if (!start || !end) return null;
  if (x < start.left || x > end.right || y < start.top || y > end.bottom) return null;
  return { ...word, pos };
}

/** ⌘ alone on a Mac, Ctrl alone elsewhere: the key that makes a click Go to Definition. */
export function navModifier(
  e: Pick<MouseEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  mac: boolean,
): boolean {
  if (e.altKey || e.shiftKey) return false;
  return mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

/** Whether `key` is a modifier on its own. */
function isModifierKey(key: string): boolean {
  return key === "Meta" || key === "Control" || key === "Alt" || key === "Shift";
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
 * pointer leaves the editor or the window loses focus. A shortcut pressed
 * with it (⌘S) hides it until the pointer moves again.
 */
function hoverLink(mac: boolean) {
  return ViewPlugin.fromClass(
    class {
      /** Where the pointer last was over the editor's text; null off it. */
      pointer: { x: number; y: number } | null = null;
      shown: { from: number; to: number } | null = null;
      /** A key other than the modifier went down: no underline until the pointer moves. */
      typed = false;
      readonly onKey: (e: KeyboardEvent) => void;
      readonly onBlur: () => void;

      constructor(readonly view: EditorView) {
        this.onKey = (e) => {
          if (e.type === "keydown" && !isModifierKey(e.key)) this.typed = true;
          this.refresh(navModifier(e, mac));
        };
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
        if (!held || !this.pointer || this.typed) {
          this.show(null);
          return;
        }
        const word = identifierUnder(this.view, this.pointer.x, this.pointer.y);
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
          this.typed = false;
          this.pointer = isCodeTarget(this.view, e.target) ? { x: e.clientX, y: e.clientY } : null;
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

/** `view` as the source of an ask: it can move its own cursor. */
export function navSource(view: EditorView): CodeNavSource {
  return {
    goTo(line, col) {
      const doc = view.state.doc;
      const target = doc.line(Math.min(Math.max(line, 1), doc.lines));
      const pos = target.from + Math.min(Math.max(col - 1, 0), target.length);
      view.dispatch({
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(pos, { y: "center" }),
      });
      view.focus();
    },
  };
}

/**
 * Go to Definition and Find Usages in the editor: F12 and ⇧F12 on the
 * identifier at the cursor, and a ⌘-click (Ctrl-click off a Mac) on one,
 * with the identifier underlined while the modifier is held. ⌥-click adds a
 * cursor, as in VS Code, and so does a ⌘-click anywhere but an identifier.
 * The keys stop at the editor, so an app binding on F12 doesn't also run.
 */
export function definitionNav(onNavigate: CodeNavHandler, mac: boolean): Extension {
  const byKey = (kind: CodeNavKind) => (view: EditorView) => {
    const word = identifierAtCursor(view.state);
    if (word) onNavigate(kind, word, navSource(view));
    return true;
  };
  return [
    navLink,
    navLinkTheme,
    hoverLink(mac),
    EditorView.clickAddsSelectionRange.of((e) => e.altKey || navModifier(e, mac)),
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
          if (e.button !== 0 || !navModifier(e, mac) || !isCodeTarget(view, e.target)) return false;
          const word = identifierUnder(view, e.clientX, e.clientY);
          if (!word) return false;
          e.preventDefault();
          view.dispatch({ selection: { anchor: word.pos }, effects: setNavLink.of(null) });
          view.focus();
          onNavigate("definition", word.word, navSource(view));
          return true;
        },
      }),
    ),
  ];
}
