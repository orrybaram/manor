/**
 * What the owner last synced (ADR-225 D4, D5), held in memory.
 *
 * The manifest and layout snapshot are read from `dataDir` once, at boot,
 * through the same strict validators a sync passes (`./owner.ts`): a file
 * that is missing starts empty, and one that is unreadable or malformed
 * starts empty with a warning — the desktop replaces it on its next connect.
 * After that every reader (`projects.getAll`, `layout.*`, the hello's host
 * name, a new agent's project) reads memory, and a sync replaces it.
 *
 * Writes are atomic (`lib/fs-atomic.ts`), so the file always holds the old
 * snapshot or the new one, never half; memory changes only once the file
 * has, so the two never disagree.
 */

import fs from "node:fs";
import { errorMessage } from "../lib/errors";
import { writeFileAtomic } from "../lib/fs-atomic";
import type { HostServerPaths } from "../paths";
import { emptyLayoutSnapshot, type HostLayoutSnapshot } from "./layout";
import { emptyManifest, type HostManifest } from "./manifest";
import { assertHostLayoutSnapshot, assertHostManifest } from "./owner";

/** `file`'s JSON if `assert` accepts it, else `empty()` (logged, unless absent). */
function load<T>(
  file: string,
  assert: (value: unknown) => asserts value is T,
  empty: () => T,
): T {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[host-server] could not read ${file}:`, errorMessage(err));
    }
    return empty();
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    assert(parsed);
    return parsed;
  } catch (err) {
    console.warn(`[host-server] ignoring ${file}: ${errorMessage(err)}`);
    return empty();
  }
}

function persist(file: string, value: unknown): void {
  writeFileAtomic(file, JSON.stringify(value), { mode: 0o600 });
}

export class OwnerSnapshotStore {
  private currentManifest: HostManifest;
  private currentLayout: HostLayoutSnapshot;

  constructor(
    private readonly paths: Pick<HostServerPaths, "manifest" | "layout">,
  ) {
    this.currentManifest = load(paths.manifest, assertHostManifest, emptyManifest);
    this.currentLayout = load(
      paths.layout,
      assertHostLayoutSnapshot,
      emptyLayoutSnapshot,
    );
  }

  manifest(): HostManifest {
    return this.currentManifest;
  }

  layout(): HostLayoutSnapshot {
    return this.currentLayout;
  }

  /** Persist, then serve, a validated manifest. Throws when it is not saved. */
  setManifest(manifest: HostManifest): void {
    persist(this.paths.manifest, manifest);
    this.currentManifest = manifest;
  }

  /** Persist, then serve, a validated layout snapshot. */
  setLayout(snapshot: HostLayoutSnapshot): void {
    persist(this.paths.layout, snapshot);
    this.currentLayout = snapshot;
  }
}
