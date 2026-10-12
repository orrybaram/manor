/**
 * How far into the daemon's hook journal the host server has read (ADR-218
 * D2), kept in `dataDir/hook-cursor.json` as `{ seq, epoch }`.
 *
 * The desktop keeps the same cursor per remote host in `projects.json`
 * (`lastHookSeq` / `hookJournalEpoch`); the host server has one journal, its
 * own daemon's, so the file holds one cursor and the `hostId` the feed passes
 * is ignored.
 *
 * **The cursor never runs ahead of agents.json.** `HostHookFeed` moves the
 * cursor after every hook it ingests, while `AgentManager` saves on a 500 ms
 * debounce. Writing the cursor first and dying before agents.json landed
 * would skip those hooks for good on the next start. So a cursor write is
 * debounced too, and always flushes agents.json (`beforeWrite`) first: a
 * crash leaves the cursor behind the agents, never ahead, and the next start
 * replays the few hooks in between — which the reconciler absorbs.
 */

import fs from "node:fs";
import type { HookCursor, HookSeqStore } from "../backend/hook-feed";
import { writeFileAtomic } from "../lib/fs-atomic";

export interface FileHookCursorStore extends HookSeqStore {
  /** Write a pending cursor now (after `beforeWrite`). */
  flush(): void;
}

export interface FileHookCursorStoreOptions {
  /** Persist whatever the cursor reflects first: `AgentManager.flushNow`. */
  beforeWrite: () => void;
  debounceMs?: number;
}

const DEFAULT_DEBOUNCE_MS = 500;

function readCursor(file: string): HookCursor | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as {
      seq?: unknown;
      epoch?: unknown;
    };
    if (
      typeof parsed.seq !== "number" ||
      !Number.isInteger(parsed.seq) ||
      parsed.seq < 0
    ) {
      return null;
    }
    return {
      seq: parsed.seq,
      epoch: typeof parsed.epoch === "string" ? parsed.epoch : null,
    };
  } catch {
    return null;
  }
}

export function fileHookCursorStore(
  file: string,
  opts: FileHookCursorStoreOptions,
): FileHookCursorStore {
  let cursor = readCursor(file);
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  function flush(): void {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!dirty || cursor === null) return;
    dirty = false;
    opts.beforeWrite();
    try {
      writeFileAtomic(file, JSON.stringify(cursor), { mode: 0o600 });
    } catch (err) {
      console.error("[host-server] could not save the hook cursor:", err);
    }
  }

  return {
    get: () => cursor,
    set: (_hostId, next) => {
      cursor = next;
      dirty = true;
      if (timer) return;
      timer = setTimeout(flush, debounceMs);
      timer.unref?.();
    },
    flush,
  };
}
