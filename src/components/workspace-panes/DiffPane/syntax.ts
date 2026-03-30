import { refractor } from "refractor/lib/core";
import type { RootContent } from "hast";
import javascript from "refractor/lang/javascript";
import typescript from "refractor/lang/typescript";
import tsx from "refractor/lang/tsx";
import jsx from "refractor/lang/jsx";
import css from "refractor/lang/css";
import markup from "refractor/lang/markup";
import json from "refractor/lang/json";
import python from "refractor/lang/python";
import go from "refractor/lang/go";
import rust from "refractor/lang/rust";
import bash from "refractor/lang/bash";
import yaml from "refractor/lang/yaml";
import markdown from "refractor/lang/markdown";

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
