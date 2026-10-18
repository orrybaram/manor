// @vitest-environment jsdom
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { uploadPastedImage, isWebApp } = vi.hoisted(() => ({
  uploadPastedImage: vi.fn(),
  isWebApp: vi.fn(),
}));

vi.mock("../../../../lib/paste-image-upload", () => ({ uploadPastedImage }));
vi.mock("../../../../lib/platform", () => ({ isWebApp }));
vi.mock("../useSlashCommands", () => ({
  useSlashCommands: () => ({
    level: null,
    skillsKnown: true,
    sync: () => {},
    lookup: () => undefined,
  }),
}));
vi.mock("../ChatStatusLine", () => ({ ChatStatusLine: () => null }));
vi.mock("../usePaneChatView", () => ({
  markChatStarting: () => {},
  startMenuHandoff: () => {},
}));

import { ChatComposer } from "../ChatComposer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  isWebApp.mockReturnValue(true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(createElement(ChatComposer, { paneId: "p1", busy: false }));
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

function input(): HTMLTextAreaElement {
  return container.querySelector<HTMLTextAreaElement>("[data-testid=chat-composer-input]")!;
}

function typeAt(value: string, caret: number) {
  const el = input();
  act(() => {
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.setSelectionRange(caret, caret);
  });
}

function paste(types: string[], file?: File): Event {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  const items = file ? [{ kind: "file", type: file.type, getAsFile: () => file }] : [];
  Object.defineProperty(event, "clipboardData", { value: { types, items } });
  act(() => {
    input().dispatchEvent(event);
  });
  return event;
}

const png = () => new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" });

describe("ChatComposer image paste", () => {
  it("inserts the uploaded path at the caret with a trailing space", async () => {
    uploadPastedImage.mockResolvedValue("/tmp/img.png");
    typeAt("hello world", 5);

    const event = paste(["Files"], png());
    expect(event.defaultPrevented).toBe(true);
    expect(uploadPastedImage).toHaveBeenCalledWith("p1", expect.any(File));
    expect(container.querySelector("[data-testid=chat-composer-uploading]")).not.toBeNull();
    expect(container.querySelector<HTMLButtonElement>("[data-testid=chat-send]")!.disabled).toBe(
      true,
    );

    await act(async () => {});
    expect(input().value).toBe("hello/tmp/img.png  world");
    expect(container.querySelector("[data-testid=chat-composer-uploading]")).toBeNull();
  });

  it("keeps text typed while the image uploads", async () => {
    let resolve!: (path: string) => void;
    uploadPastedImage.mockReturnValue(new Promise<string>((r) => (resolve = r)));
    typeAt("hello", 5);

    paste(["Files"], png());
    typeAt("hello there", 11);
    await act(async () => resolve("/tmp/img.png"));

    expect(input().value).toBe("hello/tmp/img.png  there");
  });

  it("appends the path when the text before the paste changed", async () => {
    let resolve!: (path: string) => void;
    uploadPastedImage.mockReturnValue(new Promise<string>((r) => (resolve = r)));
    typeAt("hello", 5);

    paste(["Files"], png());
    typeAt("hi", 2);
    await act(async () => resolve("/tmp/img.png"));

    expect(input().value).toBe("hi/tmp/img.png ");
  });

  it("leaves a text paste alone", () => {
    const event = paste(["text/plain"], png());
    expect(event.defaultPrevented).toBe(false);
    expect(uploadPastedImage).not.toHaveBeenCalled();
  });

  it("leaves a paste alone outside the web app", () => {
    isWebApp.mockReturnValue(false);
    const event = paste(["Files"], png());
    expect(event.defaultPrevented).toBe(false);
    expect(uploadPastedImage).not.toHaveBeenCalled();
  });

  it("shows an upload error in the error slot", async () => {
    uploadPastedImage.mockRejectedValue(new Error("Image is too large"));
    paste(["Files"], png());
    await act(async () => {});
    expect(container.textContent).toContain("Image is too large");
    expect(container.querySelector("[data-testid=chat-composer-uploading]")).toBeNull();
  });
});

function pick(...files: File[]) {
  const el = container.querySelector<HTMLInputElement>("[data-testid=chat-attach-input]")!;
  Object.defineProperty(el, "files", { value: files, configurable: true });
  act(() => {
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("ChatComposer attach button", () => {
  it("opens the file picker", () => {
    const el = container.querySelector<HTMLInputElement>("[data-testid=chat-attach-input]")!;
    const click = vi.spyOn(el, "click").mockImplementation(() => {});
    act(() => {
      container.querySelector<HTMLButtonElement>("[data-testid=chat-attach]")!.click();
    });
    expect(click).toHaveBeenCalled();
  });

  it("inserts a picked image's path at the caret", async () => {
    uploadPastedImage.mockResolvedValue("/tmp/img.png");
    typeAt("hello world", 6);

    pick(png());
    expect(uploadPastedImage).toHaveBeenCalledWith("p1", expect.any(File));
    await act(async () => {});
    expect(input().value).toBe("hello /tmp/img.png world");
  });

  it("inserts several picked images in the order picked", async () => {
    uploadPastedImage.mockResolvedValueOnce("/tmp/a.png").mockResolvedValueOnce("/tmp/b.png");
    typeAt("see  please", 4);
    pick(png(), png());
    await act(async () => {});
    await act(async () => {});
    expect(input().value).toBe("see /tmp/a.png /tmp/b.png  please");
  });

  it("is hidden outside the web app", () => {
    isWebApp.mockReturnValue(false);
    act(() => {
      root.render(createElement(ChatComposer, { paneId: "p2", busy: false }));
    });
    expect(container.querySelector("[data-testid=chat-attach]")).toBeNull();
  });
});
