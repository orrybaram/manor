import { create } from "zustand";
import type { BlameResult, FileBlame } from "../../../electron.d";
import { useOpenFileStore } from "../../../store/open-file-store";

const PREF_KEY = "manor:fileBlame";

function loadPref(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) === "1";
  } catch {
    return false;
  }
}

/** Whether file panes show blame: off until you turn it on, and then kept across relaunches. */
export const useBlamePref = create<{ on: boolean }>(() => ({ on: loadPref() }));

export function toggleBlame(): void {
  const on = !useBlamePref.getState().on;
  useBlamePref.setState({ on });
  try {
    localStorage.setItem(PREF_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
}

/** Whether the open file can be blamed, and why a blame turned on isn't showing. */
export type PaneBlame = { available: boolean; note: string | null };

type PaneBlameStore = {
  byPane: Record<string, PaneBlame>;
  set: (paneId: string, blame: PaneBlame | null) => void;
};

/**
 * Each file pane's blame status, which the pane writes and its header's toggle
 * and the palette read: they live in different trees.
 */
export const usePaneBlame = create<PaneBlameStore>((set) => ({
  byPane: {},
  set: (paneId, blame) =>
    set((s) => {
      const prev = s.byPane[paneId];
      if (blame === null) {
        if (!prev) return s;
        const { [paneId]: _gone, ...rest } = s.byPane;
        return { byPane: rest };
      }
      if (prev?.available === blame.available && prev.note === blame.note) return s;
      return { byPane: { ...s.byPane, [paneId]: blame } };
    }),
}));

/**
 * Whether the pane's open file can be blamed: git has it, and the pane could
 * open it. A binary file never opens, so it is never available.
 */
export function useFileBlameAvailable(paneId: string): boolean {
  const known = usePaneBlame((s) => s.byPane[paneId]?.available ?? false);
  const opened = useOpenFileStore((s) => s.byPane[paneId]?.status === "ready");
  return known && opened;
}

/** How a follower reaches git for one file. */
export type BlameReads = {
  revision: () => Promise<string | null>;
  blame: () => Promise<BlameResult>;
};

export type BlameFollower = {
  /** Begin, or begin again after `stop`, with blame `on` or off. */
  start(on: boolean): void;
  /** Hear each new blame to show (null for none), starting with the current one. */
  follow(onChange: (blame: FileBlame | null) => void): () => void;
  /** Blame on or off. */
  setOn(on: boolean): void;
  /** The file on disk changed (a save, a reload): the blame is out of date. */
  fileChanged(): void;
  /** Something in the workspace moved: a blame is due only if HEAD did. */
  workspaceChanged(): void;
  stop(): void;
};

/**
 * Keeps one open file's blame current. HEAD moving is what says a commit
 * happened, so a workspace change only costs a `rev-parse`; `git blame` itself
 * runs when blame is on and the answer may have changed, one at a time.
 */
export function createBlameFollower(
  reads: BlameReads,
  onStatus: (status: PaneBlame) => void,
): BlameFollower {
  let on = false;
  let listener: ((blame: FileBlame | null) => void) | null = null;
  let shown: FileBlame | null = null;
  let stopped = true;
  let running = false;
  let again = false;
  let due = true;
  let revision: string | null | undefined;

  const show = (blame: FileBlame | null) => {
    if (blame === shown) return;
    shown = blame;
    listener?.(blame);
  };

  const pass = async () => {
    const next = await reads.revision().catch(() => null);
    if (stopped) return;
    if (next !== revision) due = true;
    revision = next;
    if (next === null) {
      show(null);
      onStatus({ available: false, note: null });
      return;
    }
    if (!on) {
      show(null);
      onStatus({ available: true, note: null });
      return;
    }
    if (!due) return;
    due = false;
    const result = await reads.blame().catch(
      (err: unknown): BlameResult => ({
        ok: false,
        reason: "failed",
        message: err instanceof Error ? err.message : "Couldn't read blame",
      }),
    );
    // Turned off while it ran: the pass that turned it off has cleared the column.
    if (stopped || !on) return;
    if (result.ok) {
      show({ commits: result.commits, lines: result.lines });
      onStatus({ available: true, note: null });
    } else {
      show(null);
      onStatus({ available: true, note: result.message });
    }
  };

  const run = async () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    do {
      again = false;
      await pass();
    } while (again && !stopped);
    running = false;
  };

  return {
    start(next) {
      stopped = false;
      on = next;
      void run();
    },
    follow(onChange) {
      listener = onChange;
      if (shown) onChange(shown);
      return () => {
        if (listener === onChange) listener = null;
      };
    },
    setOn(next) {
      if (stopped || next === on) return;
      on = next;
      if (on) due = true;
      void run();
    },
    fileChanged() {
      due = true;
      if (!stopped) void run();
    },
    workspaceChanged() {
      if (!stopped) void run();
    },
    stop() {
      stopped = true;
    },
  };
}
