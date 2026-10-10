import { describe, it, expect } from "vitest";
import { encodePickerAnswer, encodePlanApproval, type PickerQuestion } from "../picker-keys";

const DOWN = "\x1b[B";
const ENTER = "\r";
const TAB = "\t";

function q(labels: string[], multiSelect = false): PickerQuestion {
  return {
    question: "Pick one",
    header: "Pick",
    multiSelect,
    options: labels.map((label) => ({ label, description: `${label} option` })),
  };
}

const FRUIT = q(["Apple", "Banana", "Cherry"]);
const COLOUR = q(["Red", "Green", "Blue"]);

// Each case mirrors a sequence scripts/spike-picker-keys.mjs confirmed.
describe("encodePickerAnswer", () => {
  it("single question, single choice: Down×i, Enter", () => {
    expect(encodePickerAnswer([FRUIT], [{ kind: "option", indexes: [2] }])).toBe(DOWN + DOWN + ENTER);
  });

  it("first option is a bare Enter", () => {
    expect(encodePickerAnswer([FRUIT], [{ kind: "option", indexes: [0] }])).toBe(ENTER);
  });

  it("other: Down to 'Type something.', the text, Enter", () => {
    expect(encodePickerAnswer([FRUIT], [{ kind: "other", text: "zebra" }])).toBe(DOWN.repeat(3) + "zebra" + ENTER);
  });

  it("multi-select: Enter toggles each, Tab to Submit, Enter", () => {
    const multi = q(["Apple", "Banana", "Cherry"], true);
    expect(encodePickerAnswer([multi], [{ kind: "option", indexes: [2, 0] }])).toBe(
      ENTER + DOWN + DOWN + ENTER + TAB + ENTER,
    );
  });

  it("two questions: answer each, then Enter on the Submit tab", () => {
    expect(
      encodePickerAnswer(
        [FRUIT, COLOUR],
        [
          { kind: "option", indexes: [1] },
          { kind: "option", indexes: [0] },
        ],
      ),
    ).toBe(DOWN + ENTER + ENTER + ENTER);
  });

  it("flattens free text to one line without control bytes", () => {
    expect(encodePickerAnswer([FRUIT], [{ kind: "other", text: "a\nb\x1b[A" }])).toBe(DOWN.repeat(3) + "a b[A" + ENTER);
  });

  it("refuses answers the picker can't take", () => {
    expect(() => encodePickerAnswer([FRUIT], [{ kind: "option", indexes: [3] }])).toThrow(/out of range/);
    expect(() => encodePickerAnswer([FRUIT], [{ kind: "option", indexes: [0, 1] }])).toThrow(/single-select/);
    expect(() => encodePickerAnswer([FRUIT], [{ kind: "option", indexes: [] }])).toThrow(/no option/);
    expect(() => encodePickerAnswer([FRUIT], [{ kind: "other", text: " \n " }])).toThrow(/empty/);
    expect(() => encodePickerAnswer([q(["A", "B"], true)], [{ kind: "other", text: "x" }])).toThrow(/multi-select/);
    expect(() => encodePickerAnswer([FRUIT, COLOUR], [{ kind: "option", indexes: [0] }])).toThrow(/expected 2/);
  });
});

describe("encodePlanApproval", () => {
  it("is Enter on option 1", () => {
    expect(encodePlanApproval()).toBe(ENTER);
  });
});
