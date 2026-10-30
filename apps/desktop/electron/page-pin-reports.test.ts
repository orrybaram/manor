import { describe, expect, it } from "vitest";
import { REPORT_LIMITS, parsePickReport, parsePinOpen, parsePinsLayout } from "./page-pin-reports";

const PICK = {
  pickId: "pin-mvv-1",
  selector: "div.card",
  outerHTML: "<div class=card></div>",
  computedStyles: { color: "red", width: 3 },
  accessibility: { role: "button" },
  boundingBox: { x: 1, y: 2, width: 3, height: 4 },
  viewport: { width: 800, height: 600 },
  reactComponents: [
    { name: "Card", source: { fileName: "src/Card.tsx", lineNumber: 12.7 } },
    { name: 7 },
    { name: "Bare", source: { fileName: 3, lineNumber: 1 } },
  ],
};
const json = (over: object = {}) => JSON.stringify({ ...PICK, ...over });

describe("parsePickReport", () => {
  it("keeps a well-formed pick, dropping fields of the wrong type", () => {
    expect(parsePickReport(json())).toEqual({
      pickId: "pin-mvv-1",
      selector: "div.card",
      outerHTML: "<div class=card></div>",
      computedStyles: { color: "red" },
      accessibility: { role: "button" },
      boundingBox: { x: 1, y: 2, width: 3, height: 4 },
      viewport: { width: 800, height: 600 },
      reactComponents: [{ name: "Card", source: { fileName: "src/Card.tsx", lineNumber: 12 } }, { name: "Bare" }],
    });
  });

  it("caps what a page could make huge", () => {
    const pick = parsePickReport(
      json({
        selector: "x".repeat(5000),
        outerHTML: "y".repeat(5000),
        reactComponents: Array.from({ length: 100 }, () => ({ name: "z".repeat(1000) })),
      }),
    )!;
    expect(pick.selector).toHaveLength(REPORT_LIMITS.selector);
    expect(pick.outerHTML).toHaveLength(REPORT_LIMITS.outerHTML);
    expect(pick.reactComponents).toHaveLength(REPORT_LIMITS.components);
    expect(pick.reactComponents![0].name).toHaveLength(REPORT_LIMITS.componentName);
  });

  it("refuses anything that isn't a pick", () => {
    expect(parsePickReport("not json")).toBeNull();
    expect(parsePickReport("[]")).toBeNull();
    expect(parsePickReport(json({ pickId: 'x"); alert(1); ("' }))).toBeNull();
    expect(parsePickReport(json({ selector: ["div"] }))).toBeNull();
    expect(parsePickReport(json({ boundingBox: { x: 1, y: 2, width: "3", height: 4 } }))).toBeNull();
    expect(parsePickReport(json({ viewport: { width: 0, height: 600 } }))).toBeNull();
  });
});

describe("parsePinsLayout", () => {
  const layout = { pins: [{ id: "pin-1", x: 1, y: 2, width: 3, height: 4, gone: false }], viewport: { width: 9, height: 9 } };

  it("keeps a well-formed layout", () => {
    expect(parsePinsLayout(JSON.stringify(layout))).toEqual(layout);
  });

  it("refuses a layout with a bad pin, or too many", () => {
    const bad = { ...layout, pins: [{ ...layout.pins[0], x: null }] };
    expect(parsePinsLayout(JSON.stringify(bad))).toBeNull();
    const many = { ...layout, pins: Array.from({ length: REPORT_LIMITS.pins + 1 }, () => layout.pins[0]) };
    expect(parsePinsLayout(JSON.stringify(many))).toBeNull();
    expect(parsePinsLayout(JSON.stringify({ pins: [] }))).toBeNull();
  });
});

describe("parsePinOpen", () => {
  it("takes an id and nothing else", () => {
    expect(parsePinOpen("pin-1")).toBe("pin-1");
    expect(parsePinOpen("")).toBeNull();
    expect(parsePinOpen("a b")).toBeNull();
  });
});
