export interface DiffLine {
  type: "context" | "add" | "del" | "hunk";
  content: string;
  oldNum?: number;
  newNum?: number;
}

export interface DiffFile {
  path: string;
  lines: DiffLine[];
  added: number;
  removed: number;
}

export type DiffMode = "local" | "branch";
