import { useState } from "react";
import { useMountEffect } from "../../hooks/useMountEffect";

/**
 * The user's first name from their GitHub profile, for the phone greeting.
 * Asking shells out to `gh`, so a hit is kept for the session; a miss (no
 * `gh`, signed out, no display name) is not, so signing in later shows up on
 * the next visit.
 */
/** The first word of a profile display name: "Ada Lovelace" -> "Ada". */
export function firstNameOf(displayName: string): string | null {
  const first = displayName.trim().split(/\s+/)[0];
  return first ? first : null;
}

let cached: string | undefined;
let pending: Promise<string | null> | null = null;

function fetchFirstName(): Promise<string | null> {
  pending ??= Promise.resolve()
    .then(() => window.electronAPI.github.getViewerName())
    .then((name) => (name ? firstNameOf(name) : null))
    .catch(() => null)
    .then((name) => {
      pending = null;
      if (name) cached = name;
      return name;
    });
  return pending;
}

/** The first name, or `null` while unknown or when there is none. */
export function useViewerFirstName(): string | null {
  const [name, setName] = useState<string | null>(cached ?? null);

  useMountEffect(() => {
    if (cached) return;
    let live = true;
    void fetchFirstName().then((n) => {
      if (live) setName(n);
    });
    return () => {
      live = false;
    };
  });

  return name;
}
