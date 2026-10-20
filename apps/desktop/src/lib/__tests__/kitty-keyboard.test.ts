import { describe, expect, it } from "vitest";
import { Terminal } from "@xterm/headless";
import { installKittyKeyboard } from "../kitty-keyboard";

function setup() {
  const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  const replies: string[] = [];
  const handle = installKittyKeyboard(term, (data) => replies.push(data));
  const write = (data: string) =>
    new Promise<void>((resolve) => term.write(data, () => resolve()));
  const screen = () => term.buffer.active.getLine(0)?.translateToString(true) ?? "";
  return { term, replies, handle, write, screen };
}

describe("installKittyKeyboard", () => {
  it("answers a query with the pushed flags", async () => {
    const { replies, write } = setup();
    await write("\x1b[?u");
    await write("\x1b[>5u\x1b[?u");
    expect(replies).toEqual(["\x1b[?0u", "\x1b[?5u"]);
  });

  it("resets the flags on pop", async () => {
    const { replies, write } = setup();
    await write("\x1b[>3u\x1b[<u\x1b[?u");
    expect(replies).toEqual(["\x1b[?0u"]);
  });

  it("sees sequences split across writes", async () => {
    const { replies, write } = setup();
    await write("\x1b[>");
    await write("7u\x1b");
    await write("[?u");
    expect(replies).toEqual(["\x1b[?7u"]);
  });

  it("keeps the sequences off the screen", async () => {
    const { write, screen } = setup();
    await write("a\x1b[>1ub\x1b[?u");
    await write("c\x1b[<u");
    expect(screen()).toBe("abc");
  });

  it("stops answering once disposed", async () => {
    const { replies, handle, write } = setup();
    handle.dispose();
    await write("\x1b[?u");
    expect(replies).toEqual([]);
  });
});
