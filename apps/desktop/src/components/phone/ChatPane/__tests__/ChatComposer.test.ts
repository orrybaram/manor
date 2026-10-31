// @vitest-environment jsdom
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { uploadPastedImage } = vi.hoisted(() => ({ uploadPastedImage: vi.fn() }));

vi.mock("../../../../lib/paste-image-upload", () => ({ uploadPastedImage }));
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
  noteSentPrompt: () => {},
  startMenuHandoff: () => {},
}));

import { ChatComposer } from "../ChatComposer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  URL.createObjectURL = vi.fn((file: Blob) => `blob:${(file as File).name}`);
  URL.revokeObjectURL = vi.fn();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(createElement(ChatComposer, { paneId: "p1", agentKind: "claude", busy: false }));
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

function thumbs(): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>("[data-testid=image-attachment]"));
}

function sendButton(): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>("[data-testid=chat-send]")!;
}

describe("ChatComposer images", () => {
  const send = vi.fn();

  beforeEach(() => {
    send.mockResolvedValue(undefined);
    (window as unknown as { electronAPI: unknown }).electronAPI = { chat: { send } };
  });

  it("shows a pasted image as a thumbnail, not a path", async () => {
    uploadPastedImage.mockResolvedValue("/tmp/img.png");
    typeAt("hello", 5);

    const event = paste(["Files"], png());
    expect(event.defaultPrevented).toBe(true);
    expect(uploadPastedImage).toHaveBeenCalledWith("p1", expect.any(File), {
      signal: expect.any(AbortSignal),
    });
    expect(thumbs()).toHaveLength(1);
    expect(thumbs()[0].dataset.uploading).toBe("true");
    expect(sendButton().disabled).toBe(true);

    await act(async () => {});
    expect(input().value).toBe("hello");
    expect(thumbs()[0].dataset.uploading).toBeUndefined();
    expect(thumbs()[0].querySelector("img")!.getAttribute("src")).toBe("blob:a.png");
    expect(sendButton().disabled).toBe(false);
  });

  it("sends the text, then each path in the order added, and clears the images", async () => {
    uploadPastedImage.mockResolvedValueOnce("/tmp/a.png").mockResolvedValueOnce("/tmp/b.png");
    typeAt("look at these  ", 15);
    pick(png(), png());
    await act(async () => {});

    await act(async () => sendButton().click());
    expect(send).toHaveBeenCalledWith("p1", "look at these /tmp/a.png /tmp/b.png");
    expect(thumbs()).toHaveLength(0);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  });

  it("sends images alone", async () => {
    uploadPastedImage.mockResolvedValue("/tmp/a.png");
    expect(sendButton().disabled).toBe(true);
    paste(["Files"], png());
    await act(async () => {});
    expect(sendButton().disabled).toBe(false);
    await act(async () => sendButton().click());
    expect(send).toHaveBeenCalledWith("p1", "/tmp/a.png");
  });

  it("leaves a removed image out of the message", async () => {
    uploadPastedImage.mockResolvedValueOnce("/tmp/a.png").mockResolvedValueOnce("/tmp/b.png");
    typeAt("hi", 2);
    pick(png(), png());
    await act(async () => {});

    act(() => thumbs()[0].querySelector<HTMLButtonElement>("[data-testid=image-attachment-remove]")!.click());
    expect(thumbs()).toHaveLength(1);
    await act(async () => sendButton().click());
    expect(send).toHaveBeenCalledWith("p1", "hi /tmp/b.png");
  });

  it("cancels an image removed while it uploads", async () => {
    let resolve!: (path: string) => void;
    uploadPastedImage.mockReturnValue(new Promise<string>((r) => (resolve = r)));
    typeAt("hi", 2);
    paste(["Files"], png());
    act(() => thumbs()[0].querySelector<HTMLButtonElement>("[data-testid=image-attachment-remove]")!.click());
    expect(sendButton().disabled).toBe(false);
    const { signal } = uploadPastedImage.mock.calls[0][2] as { signal: AbortSignal };
    expect(signal.aborted).toBe(true);
    await act(async () => resolve("/tmp/a.png"));
    expect(thumbs()).toHaveLength(0);
    await act(async () => sendButton().click());
    expect(send).toHaveBeenCalledWith("p1", "hi");
  });

  it("keeps an image added while the message sends", async () => {
    let sent!: () => void;
    send.mockReturnValue(new Promise<void>((r) => (sent = r)));
    uploadPastedImage.mockResolvedValueOnce("/tmp/a.png").mockResolvedValueOnce("/tmp/b.png");
    typeAt("hi", 2);
    paste(["Files"], png());
    await act(async () => {});
    await act(async () => sendButton().click());
    paste(["Files"], png());
    await act(async () => {});
    await act(async () => sent());

    expect(send).toHaveBeenCalledWith("p1", "hi /tmp/a.png");
    expect(thumbs()).toHaveLength(1);
    expect(thumbs()[0].dataset.uploading).toBeUndefined();
  });

  it("leaves a text paste alone", () => {
    const event = paste(["text/plain"], png());
    expect(event.defaultPrevented).toBe(false);
    expect(uploadPastedImage).not.toHaveBeenCalled();
  });

  it("drops a failed image and shows why", async () => {
    uploadPastedImage.mockRejectedValue(new Error("Image is too large"));
    paste(["Files"], png());
    await act(async () => {});
    expect(container.textContent).toContain("Image is too large");
    expect(thumbs()).toHaveLength(0);
  });

  it("attaches dropped images and ignores other files", () => {
    uploadPastedImage.mockResolvedValue("/tmp/a.png");
    const field = input().parentElement!;
    const event = new Event("drop", { bubbles: true, cancelable: true });
    const pdf = new File(["x"], "a.pdf", { type: "application/pdf" });
    Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files: [pdf, png()] } });
    act(() => {
      field.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(uploadPastedImage).toHaveBeenCalledTimes(1);
    expect(thumbs()).toHaveLength(1);
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

  it("adds each picked image as a thumbnail", () => {
    uploadPastedImage.mockResolvedValue("/tmp/img.png");
    pick(png(), png());
    expect(uploadPastedImage).toHaveBeenCalledTimes(2);
    expect(thumbs()).toHaveLength(2);
  });
});

describe("ChatComposer labels", () => {
  it("names the pane's agent", () => {
    expect(input().getAttribute("aria-label")).toBe("Message Claude");
    act(() => {
      root.render(createElement(ChatComposer, { paneId: "p1", agentKind: "codex", busy: true }));
    });
    expect(input().getAttribute("aria-label")).toBe("Message Codex");
    expect(
      container.querySelector("[data-testid=chat-stop]")?.getAttribute("aria-label"),
    ).toBe("Stop Codex");
  });
});

describe("ChatComposer Enter", () => {
  const send = vi.fn();
  let coarse = false;

  beforeEach(() => {
    coarse = false;
    send.mockResolvedValue(undefined);
    (window as unknown as { electronAPI: unknown }).electronAPI = { chat: { send } };
    window.matchMedia = ((query: string) => ({ matches: coarse && query === "(pointer: coarse)" })) as never;
  });

  function press(init: KeyboardEventInit): KeyboardEvent {
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init });
    act(() => {
      input().dispatchEvent(event);
    });
    return event;
  }

  it("sends on Enter", () => {
    typeAt("hello", 5);
    expect(press({}).defaultPrevented).toBe(true);
    expect(send).toHaveBeenCalledWith("p1", "hello");
  });

  it("leaves Shift+Enter as a new line", () => {
    typeAt("hello", 5);
    expect(press({ shiftKey: true }).defaultPrevented).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("leaves Enter as a new line on a touch screen, where ⌘+Enter still sends", () => {
    coarse = true;
    typeAt("hello", 5);
    expect(press({}).defaultPrevented).toBe(false);
    expect(send).not.toHaveBeenCalled();
    press({ metaKey: true });
    expect(send).toHaveBeenCalledWith("p1", "hello");
  });
});
