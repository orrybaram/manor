/**
 * `gh` runs on the host a repo lives on, with that host's own sign-in.
 * A host where it isn't installed or signed in is a stated
 * empty state — "gh isn't signed in on <host>" — not an error: the issues
 * panel and the PR badges say so instead of failing quietly.
 */

import { create } from "zustand";
import { isRemoteHost } from "./hosts";
import type { HostId } from "./workspace-key";

interface GhHostState {
  /** Remote hosts last found without a usable `gh`. */
  missing: Record<HostId, true>;
  set: (hostId: HostId, missing: boolean) => void;
}

export const useGhHostStore = create<GhHostState>((set) => ({
  missing: {},
  set: (hostId, missing) =>
    set((s) => {
      if (!!s.missing[hostId] === missing) return s;
      const next = { ...s.missing };
      if (missing) next[hostId] = true;
      else delete next[hostId];
      return { missing: next };
    }),
}));

/** The sentence the empty state shows for a host named `label`. */
export function ghNotSignedInText(label: string): string {
  return `gh isn't signed in on ${label}`;
}

/**
 * Ask `hostId`'s own `gh` whether it can be used, and remember the answer for
 * the empty states. A local host, or a failed check, counts as ready: the
 * caller's original error stands.
 */
export async function noteGhStatus(hostId: HostId): Promise<boolean> {
  if (!isRemoteHost(hostId)) return true;
  try {
    const status = await window.electronAPI.github.checkStatus(hostId);
    const ready = status.installed && status.authenticated;
    useGhHostStore.getState().set(hostId, !ready);
    return ready;
  } catch {
    return true;
  }
}
