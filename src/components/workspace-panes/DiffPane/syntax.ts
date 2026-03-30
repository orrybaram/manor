import { refractor } from "refractor/core";
import type { RootContent } from "hast";
import javascript from "refractor/javascript";
import typescript from "refractor/typescript";
import tsx from "refractor/tsx";
import jsx from "refractor/jsx";
import css from "refractor/css";
import markup from "refractor/markup";
import json from "refractor/json";
import python from "refractor/python";
import go from "refractor/go";
import rust from "refractor/rust";
import bash from "refractor/bash";
import yaml from "refractor/yaml";
import markdown from "refractor/markdown";

refractor.register(javascript);
refractor.register(typescript);
refractor.register(tsx);
refractor.register(jsx);
refractor.register(css);
refractor.register(markup);
refractor.register(json);
refractor.register(python);
refractor.register(go);
refractor.register(rust);
refractor.register(bash);
refractor.register(yaml);
refractor.register(markdown);

const EXT_MAP: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "tsx",
  jsx: "jsx",
  css: "css",
  html: "markup",
  htm: "markup",
  xml: "markup",
  svg: "markup",
  json: "json",
  py: "python",
  go: "go",
  rs: "rust",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yml: "yaml",
  yaml: "yaml",
  md: "markdown",
  mdx: "markdown",
};

export function extToLang(filePath: string): string | null {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return EXT_MAP[ext] ?? null;
}

export function tokenize(code: string, lang: string): RootContent[] {
  if (!refractor.registered(lang)) {
    return [{ type: "text", value: code }];
  }
  const root = refractor.highlight(code, lang);
  return root.children;
}
