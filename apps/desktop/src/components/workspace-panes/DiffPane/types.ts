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
  /** The change deletes the file: there is nothing on disk to open. */
  deleted?: boolean;
}

export type DiffMode = "local" | "branch";
