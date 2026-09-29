import { describe, expect, it } from "vitest";
import { classifyShellOutput } from "../shell-ready";

describe("classifyShellOutput", () => {
  it("is ready when the prompt follows a BEL-terminated OSC 7", () => {
    expect(classifyShellOutput("\x1b]7;file://h/p\x07\x1b[?2004h$ ")).toBe("ready");
  });

  it("is ready when the prompt follows an ST-terminated OSC 7", () => {
    expect(classifyShellOutput("\x1b]7;file://h/p\x1b\\$ ")).toBe("ready");
  });

  it("waits when the OSC 7 ends the chunk", () => {
    expect(classifyShellOutput("out\r\n\x1b]7;file://h/p\x1b\\")).toBe("osc7");
  });

  it("waits when the OSC 7 is split across chunks", () => {
    expect(classifyShellOutput("\x1b]7;file://h/p")).toBe("osc7");
  });

  it("reports plain output", () => {
    expect(classifyShellOutput("bash-5.2$ ")).toBe("output");
  });
});
