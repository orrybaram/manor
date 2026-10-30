/**
 * A browser pane's notes: elements picked on its page, each with an optional
 * remark, queued until they are sent to an agent or copied. Pure — the pane
 * holds the queue, the page draws the pins, and this decides what they are.
 */

/** A React component the picker found above the element, with its source if known. */
export interface PageNoteComponent {
  name: string;
  source?: { fileName: string; lineNumber: number };
}

/** The element's screenshot, taken in main at pick time and saved on this machine. */
export interface PageNoteScreenshot {
  /** Main's handle for it, to upload it to a remote host. */
  id: string;
  /** Where it is on this machine. */
  path: string;
}

export interface PageNote {
  /** The guest's id for the pick, which is also its pin's. */
  id: string;
  /** The page it was picked on: a queue outlives a navigation, its pins don't. */
  url: string;
  selector: string;
  outerHTML: string;
  reactComponents?: PageNoteComponent[];
  /** What the user said about it; empty for a bare pick. */
  note: string;
  screenshot: PageNoteScreenshot | null;
}

export type PageNotesAction =
  | { type: "add"; note: PageNote }
  | { type: "set-note"; id: string; note: string }
  | { type: "remove"; id: string }
  | { type: "clear" };

export function pageNotesReducer(notes: PageNote[], action: PageNotesAction): PageNote[] {
  switch (action.type) {
    case "add":
      return notes.some((n) => n.id === action.note.id) ? notes : [...notes, action.note];
    case "set-note":
      return notes.map((n) => (n.id === action.id ? { ...n, note: action.note } : n));
    case "remove":
      return notes.filter((n) => n.id !== action.id);
    case "clear":
      return notes.length === 0 ? notes : [];
  }
}

/**
 * Each note's number, as its pin shows it and the prompt cites it: its place
 * in the queue, so deleting one renumbers the rest and the two never disagree.
 */
export function pinLabels(notes: PageNote[]): Array<{ id: string; label: string }> {
  return notes.map((n, i) => ({ id: n.id, label: String(i + 1) }));
}

/** "1 note" / "3 notes". */
export function noteCountLabel(n: number): string {
  return n === 1 ? "1 note" : `${n} notes`;
}

/**
 * Where the queued notes are, for the pill after their count: "on this page",
 * or — once the pane has moved on and its pins are gone — "on another page"
 * or "across 2 pages".
 */
export function notesWhereLabel(notes: PageNote[], currentUrl: string): string {
  const urls = new Set(notes.map((n) => n.url));
  if (urls.size > 1) return `across ${urls.size} pages`;
  return urls.has(currentUrl) ? "on this page" : "on another page";
}

/** How much of an element's HTML the prompt carries: enough to recognise it. */
export const HTML_SNIPPET_MAX = 300;

/** `html` on one line, cut to `HTML_SNIPPET_MAX` characters. */
export function htmlSnippet(html: string): string {
  const flat = html.replace(/\s+/g, " ").trim();
  return flat.length > HTML_SNIPPET_MAX ? `${flat.slice(0, HTML_SNIPPET_MAX)}…` : flat;
}

/** The component nearest the element that names its source, else the nearest one. */
function componentLine(components: PageNoteComponent[] | undefined): string | null {
  if (!components || components.length === 0) return null;
  const sourced = components.find((c) => c.source);
  const c = sourced ?? components[0];
  return c.source ? `${c.name} (${c.source.fileName}:${c.source.lineNumber})` : c.name;
}

/**
 * Turn the queue into one message for an agent. Framed like a diff review
 * (`reviewPrompt`): a note on a page is as often a question as a request, so
 * the agent is told to take each on its own terms.
 *
 * `screenshotPaths` maps a note's id to where its screenshot is on the
 * agent's host; a note without one has no Screenshot line. Built multi-line;
 * `sendPromptToAgent` flattens it.
 */
export function pageNotesPrompt(
  notes: PageNote[],
  screenshotPaths: Record<string, string | undefined>,
): string {
  const urls = [...new Set(notes.map((n) => n.url))];
  const where = urls.length === 1 ? `on the page at ${urls[0]}` : `across ${urls.length} pages`;
  const lines: string[] = [
    notes.length === 1
      ? `I left a note ${where}. Take it on its own terms — it may be a question about the page rather than a request to change it. Answer a question directly, and only edit code if the note actually asks for that.`
      : `I left ${notes.length} notes ${where}. Take each on its own terms — some may be questions about the page, others requests to change it. Answer the questions directly, and only edit code where a note actually asks for that.`,
  ];
  if (notes.some((n) => !n.note.trim())) {
    lines.push("An element with no note is one I picked out for you to look at.");
  }

  notes.forEach((n, i) => {
    lines.push(`[${i + 1}] ${n.selector} — ${n.note.trim() || "(no note)"}`);
    if (urls.length > 1) lines.push(`    Page: ${n.url}`);
    const component = componentLine(n.reactComponents);
    if (component) lines.push(`    Component: ${component}`);
    const shot = screenshotPaths[n.id];
    if (shot) lines.push(`    Screenshot: ${shot}`);
    const html = htmlSnippet(n.outerHTML);
    if (html) lines.push(`    HTML: ${html}`);
  });

  return lines.join("\n");
}
