import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import {
  Facet,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  GutterMarker,
  ViewPlugin,
  WidgetType,
  gutterLineClass,
  showTooltip,
  type Tooltip,
} from "@codemirror/view";
import { useReviewStore, NO_DRAFTS, type DraftComment } from "../../../../store/review-store";
import { TooltipProvider } from "../../../ui/Tooltip/Tooltip";
import { CommentComposer, DiffCommentCard } from "../../../review/DiffCommentCard/DiffCommentCard";
import {
  anchorFor,
  cardPos,
  changesToMap,
  lineLabel,
  mapAnchor,
  selectedLines,
  snippetFor,
  spanOf,
  type Anchor,
} from "./comment-anchor";

/** Whose comments these are: the review store's workspace, and the open file. */
type CommentsConfig = { workspacePath: string; path: string };

const commentsConfig = Facet.define<CommentsConfig, CommentsConfig | null>({
  combine: (values) => values[0] ?? null,
});

/** A draft on the open file, where it is in the document now. */
type Placed = { draft: DraftComment } & Anchor;

/**
 * The composer: a new comment on a selection, or a saved one being edited.
 * `key` names this composer for as long as it is open, across rebuilds of
 * its widget.
 */
type Composing =
  | ({ kind: "new"; key: string; snippet: string } & Anchor)
  | { kind: "edit"; key: string; id: string };

let composerCount = 0;

/**
 * What an open composer holds while its widget is gone: the editor drops a
 * widget scrolled far enough out of view, and the text typed in it would go
 * with it. Kept by composer key until the composer saves or cancels.
 */
const composerText = new Map<string, string>();

type CommentsState = {
  placed: readonly Placed[];
  composing: Composing | null;
  /** The card a jump landed on, lit for a moment. */
  flash: string | null;
};

/** The store's drafts for this file, as they are now. */
const setDrafts = StateEffect.define<readonly DraftComment[]>();
const compose = StateEffect.define<Composing | null>();
/** Light a card (by comment id) for a moment; null ends it. */
export const flashComment = StateEffect.define<string | null>();

/**
 * Place `drafts` in the document: one already placed keeps its place (it has
 * followed the edits since; the store hears of them a beat later), a new one
 * goes on its stored lines.
 */
function place(state: EditorState, drafts: readonly DraftComment[], prior: readonly Placed[]): Placed[] {
  const out: Placed[] = [];
  for (const draft of drafts) {
    if (draft.startLine === undefined || draft.endLine === undefined) continue;
    const known = prior.find((p) => p.draft.id === draft.id);
    const at = known ?? anchorFor(state.doc, { startLine: draft.startLine, endLine: draft.endLine });
    out.push({ draft, from: at.from, to: at.to });
  }
  return out;
}

const commentsField = StateField.define<CommentsState>({
  create: () => ({ placed: [], composing: null, flash: null }),
  update(value, tr) {
    let { placed, composing, flash } = value;
    if (tr.docChanged && (placed.length > 0 || composing?.kind === "new")) {
      const changes = changesToMap(tr.changes, tr.startState.doc, tr.state.doc);
      const move = (a: Anchor) => mapAnchor(a, changes);
      placed = placed.map((p) => ({ ...p, ...move(p) }));
      if (composing?.kind === "new") composing = { ...composing, ...move(composing) };
    }
    for (const effect of tr.effects) {
      if (effect.is(setDrafts)) placed = place(tr.state, effect.value, placed);
      else if (effect.is(compose)) composing = effect.value;
      else if (effect.is(flashComment)) flash = effect.value;
    }
    if (composing?.kind === "edit") {
      const id = composing.id;
      if (!placed.some((p) => p.draft.id === id)) composing = null;
    }
    return placed === value.placed && composing === value.composing && flash === value.flash
      ? value
      : { placed, composing, flash };
  },
});

/** Where comment `id` is in the document, for a jump to it; null if not here. */
export function commentPosition(state: EditorState, id: string): number | null {
  const placed = state.field(commentsField, false)?.placed.find((p) => p.draft.id === id);
  return placed ? cardPos(state.doc, placed) : null;
}

/**
 * Comments on this file, following the review store and the edits: each
 * comment keeps to its lines as text is typed around it, and the lines it
 * ends up on go back to the store shortly after typing stops, and when the
 * editor closes, so the file opened again (or the review list) has them.
 * Always on, so edits made in the plain editor move them too; what shows
 * them is `diffComments`, on only in the diff view.
 */
export function reviewComments(config: CommentsConfig): Extension {
  const ours = (drafts: readonly DraftComment[]) => drafts.filter((d) => d.filePath === config.path);
  const draftsNow = () => ours(useReviewStore.getState().drafts[config.workspacePath] ?? NO_DRAFTS);
  return [
    commentsConfig.of(config),
    commentsField.init((state) => ({
      placed: place(state, draftsNow(), []),
      composing: null,
      flash: null,
    })),
    ViewPlugin.define((view) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const persist = () => {
        clearTimeout(timer);
        timer = undefined;
        const store = useReviewStore.getState();
        for (const { draft, from, to } of view.state.field(commentsField).placed) {
          const span = spanOf(view.state.doc, { from, to });
          if (span.startLine === draft.startLine && span.endLine === draft.endLine) continue;
          store.moveDraft(config.workspacePath, draft.id, { ...span, startLabel: lineLabel(span) });
        }
      };
      let last = draftsNow();
      const stop = useReviewStore.subscribe((s) => {
        const next = s.drafts[config.workspacePath] ?? NO_DRAFTS;
        const mine = ours(next);
        if (mine.length === last.length && mine.every((d, i) => d === last[i])) return;
        last = mine;
        view.dispatch({ effects: setDrafts.of(mine) });
      });
      return {
        update(update) {
          if (!update.docChanged) return;
          clearTimeout(timer);
          timer = setTimeout(persist, 400);
        },
        destroy() {
          stop();
          persist();
        },
      };
    }),
  ];
}

type Mounted = { root: Root; observer: ResizeObserver; view: EditorView };

/**
 * React inside a widget: its own root (wrapped for the card's tooltips),
 * re-measured by the editor as it grows, unmounted a tick after the widget
 * goes so it never unmounts mid-render. A new widget with the same
 * `identity` re-renders into the old one's root, so React keeps its state
 * (what a composer holds) while a label or a body changes.
 */
abstract class ReactWidget extends WidgetType {
  abstract readonly identity: string;
  abstract render(view: EditorView): ReactNode;

  private static mounted = new WeakMap<HTMLElement, Mounted>();

  toDOM(view: EditorView): HTMLElement {
    const dom = document.createElement("div");
    dom.className = "cm-reviewComment";
    dom.dataset.widget = this.identity;
    const root = createRoot(dom);
    root.render(<TooltipProvider>{this.render(view)}</TooltipProvider>);
    const observer = new ResizeObserver(() => view.requestMeasure());
    observer.observe(dom);
    ReactWidget.mounted.set(dom, { root, observer, view });
    return dom;
  }

  updateDOM(dom: HTMLElement, view: EditorView): boolean {
    const mounted = ReactWidget.mounted.get(dom);
    if (!mounted || dom.dataset.widget !== this.identity) return false;
    mounted.root.render(<TooltipProvider>{this.render(view)}</TooltipProvider>);
    return true;
  }

  destroy(dom: HTMLElement): void {
    const mounted = ReactWidget.mounted.get(dom);
    if (!mounted) return;
    this.leaving(dom, mounted.view);
    ReactWidget.mounted.delete(dom);
    mounted.observer.disconnect();
    setTimeout(() => mounted.root.unmount());
  }

  /** The widget's DOM is about to go. */
  protected leaving(_dom: HTMLElement, _view: EditorView): void {}

  get estimatedHeight(): number {
    return 60;
  }
}

class CardWidget extends ReactWidget {
  constructor(
    readonly draft: DraftComment,
    readonly label: string,
    readonly flash: boolean,
  ) {
    super();
  }

  get identity(): string {
    return `card:${this.draft.id}`;
  }

  eq(other: CardWidget): boolean {
    return (
      other.draft.id === this.draft.id &&
      other.draft.body === this.draft.body &&
      other.label === this.label &&
      other.flash === this.flash
    );
  }

  render(view: EditorView): ReactNode {
    const { draft } = this;
    return (
      <DiffCommentCard
        comment={{ ...draft, startLabel: this.label }}
        flash={this.flash}
        onEdit={() => editComment(view, draft.id)}
        onDelete={() => {
          const config = view.state.facet(commentsConfig);
          if (config) useReviewStore.getState().removeDraft(config.workspacePath, draft.id);
          view.focus();
        }}
      />
    );
  }
}

class ComposerWidget extends ReactWidget {
  constructor(
    readonly composing: Composing,
    readonly label: string,
    readonly initialBody: string,
  ) {
    super();
  }

  get identity(): string {
    return this.composing.key;
  }

  // A moved label re-renders the same composer in place (`updateDOM`).
  eq(other: ComposerWidget): boolean {
    return other.composing.key === this.composing.key && other.label === this.label;
  }

  // Scrolled out of view (not closed): keep what is typed for its return.
  protected leaving(dom: HTMLElement, view: EditorView): void {
    const open = view.state.field(commentsField, false)?.composing;
    const textarea = dom.querySelector("textarea");
    if (open?.key === this.composing.key && textarea) composerText.set(open.key, textarea.value);
  }

  render(view: EditorView): ReactNode {
    const { key } = this.composing;
    const close = () => {
      composerText.delete(key);
      view.dispatch({ effects: compose.of(null) });
      view.focus();
    };
    return (
      <CommentComposer
        startLabel={this.label}
        initialBody={composerText.get(key) ?? this.initialBody}
        onCancel={close}
        onSave={(body) => {
          const config = view.state.facet(commentsConfig);
          const state = view.state.field(commentsField);
          const composing = state.composing;
          if (config && composing?.kind === "new") {
            const span = spanOf(view.state.doc, composing);
            useReviewStore.getState().addDraft(config.workspacePath, {
              filePath: config.path,
              ...span,
              snippet: composing.snippet,
              startLabel: lineLabel(span),
              body,
            });
          } else if (config && composing?.kind === "edit") {
            useReviewStore.getState().updateDraft(config.workspacePath, composing.id, body);
          }
          close();
        }}
      />
    );
  }
}

/** Where the open composer hangs, and the text it started with. */
function composerAt(state: EditorState, composing: Composing): { pos: number; initial: string } | null {
  if (composing.kind === "new") return { pos: cardPos(state.doc, composing), initial: "" };
  const placed = state.field(commentsField).placed.find((p) => p.draft.id === composing.id);
  return placed ? { pos: cardPos(state.doc, placed), initial: placed.draft.body } : null;
}

/**
 * Edit comment `id`, unless a composer already open holds writing of its
 * own: that one is shown instead, so nothing typed is dropped. One untouched
 * gives way.
 */
function editComment(view: EditorView, id: string): void {
  const open = view.state.field(commentsField).composing;
  if (open) {
    const at = composerAt(view.state, open);
    const live = view.dom.querySelector<HTMLTextAreaElement>(
      `.cm-reviewComment[data-widget="${CSS.escape(open.key)}"] textarea`,
    );
    const text = live?.value ?? composerText.get(open.key) ?? at?.initial ?? "";
    if (at && text.trim() !== at.initial.trim()) {
      view.dispatch({ effects: EditorView.scrollIntoView(at.pos, { y: "center" }) });
      requestAnimationFrame(() =>
        view.dom
          .querySelector<HTMLTextAreaElement>(
            `.cm-reviewComment[data-widget="${CSS.escape(open.key)}"] textarea`,
          )
          ?.focus(),
      );
      return;
    }
    composerText.delete(open.key);
  }
  view.dispatch({ effects: compose.of({ kind: "edit", key: `edit:${id}`, id }) });
}

const commentedMarker = new (class extends GutterMarker {
  elementClass = "cm-commentedLine";
})();

/** Cards under their last lines, and the composer under the selection it is for. */
const commentWidgets = EditorView.decorations.compute([commentsField], (state) => {
  const { placed, composing, flash } = state.field(commentsField);
  const widgets: { pos: number; widget: WidgetType }[] = [];
  for (const p of placed) {
    const label = lineLabel(spanOf(state.doc, p));
    if (composing?.kind === "edit" && composing.id === p.draft.id) {
      widgets.push({ pos: cardPos(state.doc, p), widget: new ComposerWidget(composing, label, p.draft.body) });
    } else {
      widgets.push({ pos: cardPos(state.doc, p), widget: new CardWidget(p.draft, label, flash === p.draft.id) });
    }
  }
  if (composing?.kind === "new") {
    const label = lineLabel(spanOf(state.doc, composing));
    widgets.push({ pos: cardPos(state.doc, composing), widget: new ComposerWidget(composing, label, "") });
  }
  widgets.sort((a, b) => a.pos - b.pos);
  const builder = new RangeSetBuilder<Decoration>();
  for (const { pos, widget } of widgets) {
    builder.add(pos, pos, Decoration.widget({ widget, block: true, side: 1 }));
  }
  return builder.finish();
});

/** The gutter accent on each line a comment covers. */
const commentedLines = gutterLineClass.compute([commentsField], (state) => {
  const lines = new Set<number>();
  for (const p of state.field(commentsField).placed) {
    const { startLine, endLine } = spanOf(state.doc, p);
    for (let n = startLine; n <= endLine; n++) lines.add(n);
  }
  const builder = new RangeSetBuilder<GutterMarker>();
  for (const n of [...lines].sort((a, b) => a - b)) {
    const from = state.doc.line(n).from;
    builder.add(from, from, commentedMarker);
  }
  return builder.finish();
});

/** Comment on the selected lines: open the composer under them. */
function startComment(view: EditorView): boolean {
  const { from, to } = view.state.selection.main;
  if (from === to || !view.state.facet(commentsConfig)) return false;
  const doc = view.state.doc;
  const at = anchorFor(doc, selectedLines(doc, from, to));
  view.dispatch({
    effects: compose.of({
      kind: "new",
      key: `new:${++composerCount}`,
      ...at,
      snippet: snippetFor(view.state, from, to),
    }),
    // The selection has done its job; left lit behind the composer it reads as still live.
    selection: { anchor: at.to },
  });
  return true;
}

// One function for every chip, so the editor keeps the chip's DOM as the
// selection moves rather than rebuilding it.
function createChip(view: EditorView) {
  const dom = document.createElement("div");
  dom.className = "cm-commentChip";
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "+ Comment";
  button.dataset.testid = "diff-comment-chip";
  // The selection stays put until the click lands.
  button.addEventListener("mousedown", (e) => e.preventDefault());
  button.addEventListener("click", () => startComment(view));
  dom.appendChild(button);
  return { dom };
}

/** The "+ Comment" chip under a selection, while nothing is being written. */
const commentChip = showTooltip.compute(["selection", commentsField], (state): Tooltip | null => {
  const { from, to } = state.selection.main;
  if (from === to || state.field(commentsField).composing) return null;
  const { endLine } = selectedLines(state.doc, from, to);
  return {
    pos: Math.min(to, state.doc.line(endLine).to),
    above: false,
    create: createChip,
  };
});

const commentTheme = EditorView.theme({
  ".cm-reviewComment": {
    padding: "4px 12px 6px 8px",
    borderLeft: "2px solid var(--accent)",
    marginLeft: "2px",
  },
  ".cm-gutterElement.cm-commentedLine": {
    color: "var(--accent)",
    boxShadow: "inset -2px 0 0 var(--accent)",
  },
  ".cm-tooltip.cm-commentChip": { border: "none", background: "transparent" },
  ".cm-commentChip button": {
    marginTop: "4px",
    padding: "2px 10px",
    border: "none",
    borderRadius: "999px",
    background: "var(--accent)",
    color: "var(--bg)",
    font: "500 11px/18px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    cursor: "pointer",
    boxShadow: "0 2px 8px rgba(0, 0, 0, 0.25)",
  },
});

/**
 * What shows the comments, in the diff view: the cards and composer under
 * their lines, the gutter accent, and the chip on a selection. Needs
 * `reviewComments` in the editor.
 */
export function diffComments(): Extension {
  return [commentWidgets, commentedLines, commentChip, commentTheme];
}
