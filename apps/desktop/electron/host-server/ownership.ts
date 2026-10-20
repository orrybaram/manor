/**
 * Whether a host server owns its host yet.
 *
 * A host server starts `pending`: the desktop still holds this host's
 * projects, agents and layout from before the flip. Until it has handed them
 * over (`hostServer.adopt`, `./adopt.ts`), the server serves no project or layout
 * write and lists no projects, so nothing is created here that adoption
 * would then have to merge with. After that it is `host`, for good: the box
 * is the source of truth for its own state.
 *
 * Persisted in `dataDir/ownership.json` (`hostServerPaths().ownership`). A
 * file that is missing or unreadable reads `pending`: adoption merges, so
 * asking for it again is harmless, and serving writes it never agreed to is
 * not.
 */

import fs from "node:fs";
import { errorMessage } from "../lib/errors";
import { writeFileAtomic } from "../lib/fs-atomic";
import { UNAVAILABLE_HOST_CODE, BridgeUnavailableRefusal } from "../bridge/types";

export type HostOwnership = "pending" | "host";

/** What a project or layout write is refused with until adoption. */
export const PENDING_MESSAGE = "This host is being set up";

export interface OwnershipState {
  current(): HostOwnership;
  /** Persist, then answer, `ownership`. Throws when it is not saved. */
  set(ownership: HostOwnership): void;
}

function read(file: string): HostOwnership {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[host-server] could not read ${file}:`, errorMessage(err));
    }
    return "pending";
  }
  try {
    const parsed = JSON.parse(raw) as { ownership?: unknown };
    if (parsed.ownership === "host" || parsed.ownership === "pending") {
      return parsed.ownership;
    }
    throw new Error(`unknown ownership ${JSON.stringify(parsed.ownership)}`);
  } catch (err) {
    console.warn(`[host-server] ignoring ${file}: ${errorMessage(err)}`);
    return "pending";
  }
}

/** Write `ownership` to `file`, atomically. */
export function writeOwnership(file: string, ownership: HostOwnership): void {
  writeFileAtomic(file, JSON.stringify({ ownership }), { mode: 0o600 });
}

/** The state in `file`, read once and held. */
export function fileOwnershipState(file: string): OwnershipState {
  let current = read(file);
  return {
    current: () => current,
    set(ownership) {
      writeOwnership(file, ownership);
      current = ownership;
    },
  };
}

/** Throws the stated refusal unless the host has been adopted. */
export function assertOwned(state: Pick<OwnershipState, "current">): void {
  if (state.current() !== "host") {
    throw new BridgeUnavailableRefusal(PENDING_MESSAGE, UNAVAILABLE_HOST_CODE);
  }
}
