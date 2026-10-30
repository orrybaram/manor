import { describe, it, expect } from "vitest";
import {
  HTML_SNIPPET_MAX,
  htmlSnippet,
  noteCountLabel,
  notesWhereLabel,
  pageNotesPrompt,
  pageNotesReducer,
  pinLabels,
  type PageNote,
} from "../page-notes";

function makeNote(overrides: Partial<PageNote> = {}): PageNote {
  return {
    id: "p1",
    url: "http://localhost:3000/settings",
    selector: "div.card.plan",
    outerHTML: '<div class="card plan"><strong>Plan</strong></div>',
    note: "",
    screenshot: { id: "s1", path: "/home/me/.manor/pasted-images/a.png" },
    ...overrides,
  };
}

describe("pageNotesReducer", () => {
  it("adds, annotates, removes and clears", () => {
    let notes = pageNotesReducer([], { type: "add", note: makeNote() });
    notes = pageNotesReducer(notes, { type: "add", note: makeNote({ id: "p2" }) });
    expect(notes.map((n) => n.id)).toEqual(["p1", "p2"]);

    notes = pageNotesReducer(notes, { type: "set-note", id: "p2", note: "Too tall" });
    expect(notes[1].note).toBe("Too tall");
    expect(notes[0].note).toBe("");

    notes = pageNotesReducer(notes, { type: "remove", id: "p1" });
    expect(notes.map((n) => n.id)).toEqual(["p2"]);

    expect(pageNotesReducer(notes, { type: "clear" })).toEqual([]);
  });

  it("ignores a pick it already holds", () => {
    const notes = pageNotesReducer([], { type: "add", note: makeNote() });
    expect(pageNotesReducer(notes, { type: "add", note: makeNote({ note: "again" }) })).toBe(notes);
  });
});

describe("pinLabels", () => {
  it("numbers pins by their place in the queue, so a delete renumbers", () => {
    const notes = [makeNote({ id: "a" }), makeNote({ id: "b" }), makeNote({ id: "c" })];
    expect(pinLabels(notes)).toEqual([
      { id: "a", label: "1" },
      { id: "b", label: "2" },
      { id: "c", label: "3" },
    ]);
    const after = pageNotesReducer(notes, { type: "remove", id: "a" });
    expect(pinLabels(after)).toEqual([
      { id: "b", label: "1" },
      { id: "c", label: "2" },
    ]);
  });
});

describe("noteCountLabel", () => {
  it("counts", () => {
    expect(noteCountLabel(1)).toBe("1 note");
    expect(noteCountLabel(3)).toBe("3 notes");
  });
});

describe("notesWhereLabel", () => {
  it("says where the queue is, against the page now shown", () => {
    const here = makeNote();
    expect(notesWhereLabel([here], here.url)).toBe("on this page");
    expect(notesWhereLabel([here], "http://localhost:3000/billing")).toBe("on another page");
    expect(notesWhereLabel([here, makeNote({ id: "b", url: "http://x/" })], here.url)).toBe("across 2 pages");
  });
});

describe("htmlSnippet", () => {
  it("puts the HTML on one line and caps it", () => {
    expect(htmlSnippet("<div>\n  <b>x</b>\n</div>")).toBe("<div> <b>x</b> </div>");
    const long = `<p>${"x".repeat(1000)}</p>`;
    const cut = htmlSnippet(long);
    expect(cut.length).toBe(HTML_SNIPPET_MAX + 1);
    expect(cut.endsWith("…")).toBe(true);
  });
});

describe("pageNotesPrompt", () => {
  it("frames one bare pick as something to look at, not an order", () => {
    const prompt = pageNotesPrompt([makeNote()], { p1: "/box/a.png" });
    const [preamble, ...rest] = prompt.split("\n");
    expect(preamble).toContain("I left a note on the page at http://localhost:3000/settings.");
    expect(preamble).toContain("may be a question");
    expect(preamble).not.toMatch(/^(Fix|Address)/);
    expect(rest).toEqual([
      "An element with no note is one I picked out for you to look at.",
      "[1] div.card.plan — (no note)",
      "    Screenshot: /box/a.png",
      '    HTML: <div class="card plan"><strong>Plan</strong></div>',
    ]);
  });

  it("lists every note with its component, screenshot and HTML", () => {
    const notes = [
      makeNote({
        id: "a",
        note: "Show seats used, e.g. 9 / 12",
        reactComponents: [
          { name: "Card" },
          { name: "PlanCard", source: { fileName: "src/PlanCard.tsx", lineNumber: 12 } },
        ],
      }),
      makeNote({ id: "b", selector: "button.upgrade", note: "Rename to Upgrade" }),
      makeNote({ id: "c", selector: "footer", note: "  " }),
    ];
    const prompt = pageNotesPrompt(notes, { a: "/a.png", b: "/b.png", c: "/c.png" });
    expect(prompt.split("\n")[0]).toContain("I left 3 notes on the page at http://localhost:3000/settings.");
    expect(prompt).toContain("[1] div.card.plan — Show seats used, e.g. 9 / 12");
    expect(prompt).toContain("    Component: PlanCard (src/PlanCard.tsx:12)");
    expect(prompt).toContain("[2] button.upgrade — Rename to Upgrade");
    expect(prompt).toContain("[3] footer — (no note)");
    expect(prompt.match(/Screenshot: /g)).toHaveLength(3);
    expect(prompt).not.toContain("Page:");
  });

  it("names each note's page when they span more than one", () => {
    const prompt = pageNotesPrompt(
      [makeNote({ id: "a", note: "x" }), makeNote({ id: "b", note: "y", url: "http://localhost:3000/billing" })],
      {},
    );
    expect(prompt.split("\n")[0]).toContain("across 2 pages");
    expect(prompt).toContain("    Page: http://localhost:3000/billing");
    expect(prompt).not.toContain("Screenshot:");
    expect(prompt).not.toContain("picked out for you");
  });
});
