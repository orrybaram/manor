import type { ComponentType } from "react";
import type { LucideProps } from "lucide-react";
import File from "lucide-react/dist/esm/icons/file";
import CodeXml from "lucide-react/dist/esm/icons/code-xml";
import Braces from "lucide-react/dist/esm/icons/braces";
import FileJson from "lucide-react/dist/esm/icons/file-json";
import FileText from "lucide-react/dist/esm/icons/file-text";
import FileImage from "lucide-react/dist/esm/icons/file-image";
import FileTerminal from "lucide-react/dist/esm/icons/file-terminal";
import FileCog from "lucide-react/dist/esm/icons/file-cog";
import FileLock from "lucide-react/dist/esm/icons/file-lock";
import FileArchive from "lucide-react/dist/esm/icons/file-archive";
import FileVideo from "lucide-react/dist/esm/icons/file-video";
import FileAudio from "lucide-react/dist/esm/icons/file-audio";
import FileSpreadsheet from "lucide-react/dist/esm/icons/file-spreadsheet";
import Palette from "lucide-react/dist/esm/icons/palette";
import Database from "lucide-react/dist/esm/icons/database";

export type FileIcon = ComponentType<LucideProps>;

const byExtension: Record<string, FileIcon> = {
  // code
  ts: CodeXml,
  tsx: CodeXml,
  js: CodeXml,
  jsx: CodeXml,
  mjs: CodeXml,
  cjs: CodeXml,
  mts: CodeXml,
  cts: CodeXml,
  py: CodeXml,
  rb: CodeXml,
  go: CodeXml,
  rs: CodeXml,
  java: CodeXml,
  kt: CodeXml,
  swift: CodeXml,
  c: CodeXml,
  h: CodeXml,
  cpp: CodeXml,
  hpp: CodeXml,
  cs: CodeXml,
  php: CodeXml,
  lua: CodeXml,
  gd: CodeXml,
  // markup / styles
  html: Braces,
  htm: Braces,
  xml: Braces,
  svg: Braces,
  vue: Braces,
  svelte: Braces,
  astro: Braces,
  css: Palette,
  scss: Palette,
  sass: Palette,
  less: Palette,
  // data / config
  json: FileJson,
  jsonc: FileJson,
  json5: FileJson,
  yaml: FileCog,
  yml: FileCog,
  toml: FileCog,
  ini: FileCog,
  env: FileCog,
  conf: FileCog,
  cfg: FileCog,
  properties: FileCog,
  lock: FileLock,
  sql: Database,
  db: Database,
  sqlite: Database,
  csv: FileSpreadsheet,
  tsv: FileSpreadsheet,
  xls: FileSpreadsheet,
  xlsx: FileSpreadsheet,
  // docs
  md: FileText,
  mdx: FileText,
  txt: FileText,
  rst: FileText,
  adoc: FileText,
  log: FileText,
  pdf: FileText,
  // shell
  sh: FileTerminal,
  bash: FileTerminal,
  zsh: FileTerminal,
  fish: FileTerminal,
  ps1: FileTerminal,
  bat: FileTerminal,
  cmd: FileTerminal,
  // media
  png: FileImage,
  jpg: FileImage,
  jpeg: FileImage,
  gif: FileImage,
  webp: FileImage,
  ico: FileImage,
  icns: FileImage,
  bmp: FileImage,
  avif: FileImage,
  mp4: FileVideo,
  mov: FileVideo,
  webm: FileVideo,
  mkv: FileVideo,
  mp3: FileAudio,
  wav: FileAudio,
  ogg: FileAudio,
  flac: FileAudio,
  // archives
  zip: FileArchive,
  tar: FileArchive,
  gz: FileArchive,
  tgz: FileArchive,
  bz2: FileArchive,
  xz: FileArchive,
  "7z": FileArchive,
  rar: FileArchive,
};

const byBasename: Record<string, FileIcon> = {
  dockerfile: FileCog,
  makefile: FileTerminal,
  license: FileText,
  readme: FileText,
  changelog: FileText,
  ".gitignore": FileCog,
  ".gitattributes": FileCog,
  ".npmrc": FileCog,
  ".nvmrc": FileCog,
  ".editorconfig": FileCog,
  ".prettierrc": FileCog,
  ".eslintrc": FileCog,
  ".env": FileCog,
};

/** Pick an icon for a file path by extension, falling back to a generic file. */
export function fileIconFor(path: string): FileIcon {
  const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const named = byBasename[base];
  if (named) return named;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return File;
  return byExtension[base.slice(dot + 1)] ?? File;
}
