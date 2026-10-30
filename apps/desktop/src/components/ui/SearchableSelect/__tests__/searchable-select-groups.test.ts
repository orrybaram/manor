// @vitest-environment happy-dom
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestRoot, type TestRoot } from "../../../../test-utils/react-root";
import { SearchableSelect } from "../SearchableSelect";

/** Group headings, disabled options and action rows in the list. */
describe("SearchableSelect groups, disabled options and actions", () => {
  let root: TestRoot;

  beforeEach(() => {
    root = createTestRoot();
    document.body.appendChild(root.container);
  });

  afterEach(() => {
    root.unmount();
    document.body.innerHTML = "";
  });

  const options = [
    { value: "a", label: "Alpha", group: "First" },
    { value: "b", label: "Bravo", group: "Second", disabledReason: "Offline" },
    { value: "c", label: "Charlie", group: "Second" },
  ];

  async function open(props: Record<string, unknown>) {
    await act(async () => {
      root.render(
        createElement(SearchableSelect, {
          value: "c",
          onChange: () => {},
          options,
          triggerLabel: "custom trigger",
          "data-testid": "select",
          ...props,
        }),
      );
    });
    const trigger = document.querySelector<HTMLButtonElement>('[data-testid="select"]')!;
    expect(trigger.textContent).toContain("custom trigger");
    await act(async () => {
      trigger.click();
    });
    return document.querySelector<HTMLInputElement>("input")!;
  }

  const rows = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
  const press = (input: HTMLInputElement, key: string) =>
    act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    });

  it("lists options under their group headings in place, not pinning the selected one", async () => {
    await open({});
    expect(rows().map((r) => r.textContent)).toEqual(["Alpha", "BravoOffline", "Charlie"]);
    const text = document.querySelector('[role="listbox"]')!.textContent;
    expect(text?.indexOf("First")).toBeLessThan(text!.indexOf("Alpha"));
    expect(text?.indexOf("Second")).toBeLessThan(text!.indexOf("Bravo"));
  });

  it("skips a disabled option with the arrow keys and ignores a click on it", async () => {
    const onChange = vi.fn();
    const input = await open({ onChange });
    await press(input, "ArrowDown");
    expect(rows()[2].getAttribute("aria-selected")).toBe("true");
    rows()[1].dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(onChange).not.toHaveBeenCalled();
    await press(input, "Enter");
    expect(onChange).toHaveBeenCalledWith("c");
  });

  it("reaches an action row by keyboard and runs it", async () => {
    const onSelect = vi.fn();
    const input = await open({
      actions: [{ label: "Set up elsewhere", onSelect, "data-testid": "act" }],
    });
    await press(input, "ArrowUp");
    expect(document.querySelector('[data-testid="act"]')?.getAttribute("aria-selected")).toBe("true");
    await press(input, "Enter");
    expect(onSelect).toHaveBeenCalledOnce();
  });
});
