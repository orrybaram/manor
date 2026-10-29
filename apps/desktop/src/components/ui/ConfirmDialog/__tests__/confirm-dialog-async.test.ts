// @vitest-environment happy-dom
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestRoot, type TestRoot } from "../../../../test-utils/react-root";
import { ConfirmDialog } from "../ConfirmDialog";
import { clearRecords, toastStore } from "../../../../toast/toast-store";
import { toast } from "../../../../toast";

/** An async confirm waits, and a failure keeps the dialog open. */
describe("ConfirmDialog with an async onConfirm", () => {
  let root: TestRoot;

  beforeEach(() => {
    clearRecords();
    root = createTestRoot();
  });

  afterEach(() => {
    root.unmount();
    document.body.innerHTML = "";
  });

  function button(label: string): HTMLButtonElement {
    const found = [...document.body.querySelectorAll("button")].find(
      (b) => b.textContent === label,
    );
    if (!found) throw new Error(`no ${label} button`);
    return found;
  }

  function render(onConfirm: () => Promise<void>, onCancel = vi.fn()) {
    root.render(
      createElement(ConfirmDialog, {
        open: true,
        title: "Remove",
        description: "Sure?",
        confirmLabel: "Remove",
        onConfirm,
        onCancel,
      }),
    );
    return onCancel;
  }

  it("disables confirm while pending, then re-enables it on failure", async () => {
    let reject!: (err: Error) => void;
    const onCancel = render(() => new Promise<void>((_r, rej) => (reject = rej)));

    act(() => button("Remove").click());
    expect(button("Remove").disabled).toBe(true);
    // Cancel stays live: a promise that never settles can't trap the user.
    expect(button("Cancel").disabled).toBe(false);

    await act(async () => {
      reject(new Error("locked"));
    });

    expect(button("Remove").disabled).toBe(false);
    expect(onCancel).not.toHaveBeenCalled();
    expect(toastStore.getState().toasts[0]?.detail).toBe("locked");
  });

  it("does not toast an error the action already reported", async () => {
    const err = new Error("locked");
    render(async () => {
      toast.error("Couldn't remove", { id: "remove", error: err });
      throw err;
    });

    await act(async () => button("Remove").click());

    expect(toastStore.getState().toasts.map((t) => t.id)).toEqual(["remove"]);
  });
});
