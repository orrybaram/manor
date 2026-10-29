import { describe, it, expect } from "vitest";
import File from "lucide-react/dist/esm/icons/file";
import CodeXml from "lucide-react/dist/esm/icons/code-xml";
import Palette from "lucide-react/dist/esm/icons/palette";
import FileJson from "lucide-react/dist/esm/icons/file-json";
import FileCog from "lucide-react/dist/esm/icons/file-cog";
import FileText from "lucide-react/dist/esm/icons/file-text";
import { fileIconFor } from "./file-icon";

describe("fileIconFor", () => {
  it("maps by extension, case-insensitive", () => {
    expect(fileIconFor("src/App.tsx")).toBe(CodeXml);
    expect(fileIconFor("src/App.module.CSS")).toBe(Palette);
    expect(fileIconFor("package.json")).toBe(FileJson);
    expect(fileIconFor("docs/README.md")).toBe(FileText);
  });

  it("maps well-known basenames without extensions", () => {
    expect(fileIconFor("Dockerfile")).toBe(FileCog);
    expect(fileIconFor(".gitignore")).toBe(FileCog);
    expect(fileIconFor("LICENSE")).toBe(FileText);
  });

  it("falls back to a generic file icon", () => {
    expect(fileIconFor("bin/manor")).toBe(File);
    expect(fileIconFor("weird.unknownext")).toBe(File);
    expect(fileIconFor(".hiddenfile")).toBe(File);
  });
});
