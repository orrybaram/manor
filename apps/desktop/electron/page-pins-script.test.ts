// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PICKER_SCRIPT } from "./picker-script";
import {
  PINS_PREFIX,
  PINS_SCRIPT,
  PIN_OPEN_PREFIX,
  PIN_PICK_PREFIX,
  PIN_STOP_MESSAGE,
  pinsCall,
} from "./page-pins-script";

type Pins = {
  start(): void;
  stop(): void;
  release(pickId: string): void;
  sync(list: Array<{ id: string; label: string }>): void;
};

const frames = () => new Promise((resolve) => setTimeout(resolve, 60));

describe("page pins script", () => {
  let debug: ReturnType<typeof vi.spyOn>;
  let shadow: ShadowRoot | null = null;

  beforeEach(() => {
    document.body.innerHTML = `
      <div class="card" id="one">One</div>
      <div class="card" id="two">Two</div>`;
    // happy-dom lays nothing out.
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const y = this.id === "two" ? 100 : 20;
      return { x: 10, y, left: 10, top: y, width: 200, height: 50, right: 210, bottom: y + 50, toJSON() {} } as DOMRect;
    });
    // The script's root is closed; keep a handle on it to look inside.
    const attach = Element.prototype.attachShadow;
    vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (this: Element, init) {
      shadow = attach.call(this, init);
      return shadow;
    });
    debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    delete (window as unknown as { __manor_pins__?: Pins }).__manor_pins__;
    new Function(PINS_SCRIPT)();
  });

  afterEach(async () => {
    // Each test injects a fresh copy into the same window: quiet this one.
    pins()?.stop();
    pins()?.sync([]);
    await frames();
    vi.restoreAllMocks();
    document.querySelector("manor-pins")?.remove();
  });

  const reports = (prefix: string) =>
    debug.mock.calls.map((c: unknown[]) => String(c[0])).filter((m: string) => m.startsWith(prefix));
  const pins = () => (window as unknown as { __manor_pins__?: Pins }).__manor_pins__!;

  it("stays armed across picks, and pins each one once it is numbered", async () => {
    pins().start();
    for (const id of ["one", "two"]) {
      const el = document.getElementById(id)!;
      el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await frames();
    }

    const picks = reports(PIN_PICK_PREFIX).map((m: string) => JSON.parse(m.slice(PIN_PICK_PREFIX.length)));
    expect(picks.map((p: { selector: string }) => p.selector)).toEqual(["div#one", "div#two"]);
    expect(picks[0].boundingBox).toEqual({ x: 10, y: 20, width: 200, height: 50 });

    pins().sync(picks.map((p: { pickId: string }, i: number) => ({ id: p.pickId, label: String(i + 1) })));
    await frames();
    const badges = Array.from(shadow!.querySelectorAll(".pin"), (b) => b.textContent);
    expect(badges).toEqual(["1", "2"]);

    const last = reports(PINS_PREFIX).at(-1)!;
    const state = JSON.parse(last.slice(PINS_PREFIX.length));
    expect(state.pins.map((p: { y: number; gone: boolean }) => [p.y, p.gone])).toEqual([
      [20, false],
      [100, false],
    ]);
  });

  it("dims a pin whose element is gone, and reports a pin click", async () => {
    pins().start();
    const el = document.getElementById("two")!;
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await frames();
    const [pick] = reports(PIN_PICK_PREFIX).map((m: string) => JSON.parse(m.slice(PIN_PICK_PREFIX.length)));
    pins().sync([{ id: pick.pickId, label: "1" }]);
    await frames();

    el.remove();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const state = JSON.parse(reports(PINS_PREFIX).at(-1)!.slice(PINS_PREFIX.length));
    expect(state.pins).toEqual([expect.objectContaining({ id: pick.pickId, gone: true, y: 100 })]);
    expect(shadow!.querySelector(".pin")!.classList.contains("gone")).toBe(true);

    (shadow!.querySelector(".pin") as HTMLElement).click();
    expect(reports(PIN_OPEN_PREFIX)).toEqual([`${PIN_OPEN_PREFIX}${pick.pickId}`]);
  });

  const click = (id: string) => {
    const el = document.getElementById(id)!;
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  };
  const pickIds = () =>
    reports(PIN_PICK_PREFIX).map((m: string) => JSON.parse(m.slice(PIN_PICK_PREFIX.length)).pickId as string);
  const layerShown = () => (document.querySelector("manor-pins") as HTMLElement).style.visibility !== "hidden";

  it("keeps the pins hidden until every pending screenshot is taken", async () => {
    pins().start();
    click("one");
    click("two");
    await frames();
    const [a, b] = pickIds();
    expect(layerShown()).toBe(false);
    pins().release(a);
    expect(layerShown()).toBe(false);
    pins().release(b);
    expect(layerShown()).toBe(true);
  });

  it("stands aside while an agent's one-shot picker is on the page", async () => {
    const page = window as unknown as { __manor_picker_active__?: boolean };
    pins().start();
    page.__manor_picker_active__ = true;
    const seen = vi.fn();
    document.addEventListener("click", seen, true);
    click("one");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await frames();
    document.removeEventListener("click", seen, true);
    delete page.__manor_picker_active__;
    expect(seen).toHaveBeenCalled();
    expect(pickIds()).toEqual([]);
    expect(reports(PIN_STOP_MESSAGE)).toEqual([]);
  });

  it("stops on Escape and says so", () => {
    pins().start();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(reports(PIN_STOP_MESSAGE)).toEqual([PIN_STOP_MESSAGE]);
  });

  it("is a no-op call on a page without it", () => {
    delete (window as unknown as { __manor_pins__?: Pins }).__manor_pins__;
    expect(() => new Function(pinsCall("sync", [{ id: "x", label: "1" }]))()).not.toThrow();
  });
});

describe("element picker script", () => {
  it("still parses with its helpers spliced in", () => {
    expect(() => new Function(PICKER_SCRIPT)).not.toThrow();
  });
});
