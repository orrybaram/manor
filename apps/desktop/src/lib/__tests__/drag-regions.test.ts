// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { POPOVER_OPEN_CLASS, watchPopoversForDragRegions } from "../drag-regions";

/** MutationObserver callbacks run as a microtask after the change. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const standingDown = () =>
  document.documentElement.classList.contains(POPOVER_OPEN_CLASS);

function popper(role: string, state = "open"): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.setAttribute("data-radix-popper-content-wrapper", "");
  const content = document.createElement("div");
  content.setAttribute("role", role);
  content.setAttribute("data-state", state);
  wrapper.append(content);
  return wrapper;
}

let stop: (() => void) | null = null;
afterEach(() => {
  stop?.();
  stop = null;
  document.body.replaceChildren();
});

describe("watchPopoversForDragRegions", () => {
  it("stands drag regions down while a portaled menu is open", async () => {
    stop = watchPopoversForDragRegions();
    const portal = document.createElement("div");
    portal.append(popper("menu"));
    document.body.append(portal);
    await settle();
    expect(standingDown()).toBe(true);

    portal.remove();
    await settle();
    expect(standingDown()).toBe(false);
  });

  it("follows a popover rendered in place through its data-state", async () => {
    const dialog = document.createElement("div");
    document.body.append(dialog);
    stop = watchPopoversForDragRegions();

    const trigger = document.createElement("button");
    trigger.setAttribute("data-state", "closed");
    dialog.append(trigger);
    await settle();

    // Opening: the content mounts deep in the tree and the trigger flips.
    const content = popper("dialog");
    dialog.append(content);
    trigger.setAttribute("data-state", "open");
    await settle();
    expect(standingDown()).toBe(true);

    // Closing: the content flips before its exit animation removes it.
    content.firstElementChild!.setAttribute("data-state", "closed");
    trigger.setAttribute("data-state", "closed");
    await settle();
    expect(standingDown()).toBe(false);
  });

  it("leaves the window draggable for a tooltip", async () => {
    stop = watchPopoversForDragRegions();
    document.body.append(popper("tooltip"));
    await settle();
    expect(standingDown()).toBe(false);
  });

  it("picks up a popper already open when it starts", () => {
    document.body.append(popper("menu"));
    stop = watchPopoversForDragRegions();
    expect(standingDown()).toBe(true);
  });
});
