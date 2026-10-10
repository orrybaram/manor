import { useState } from "react";
import { useMountEffect } from "../../../hooks/useMountEffect";

/**
 * The signed-in GitHub login for the trophy room header (ADR-212). Asking
 * shells out to `gh auth status`, so the answer is kept for the session and
 * reopening the palette reads it straight back. A miss (not installed, not
 * signed in) is not kept, so signing in later shows up on the next visit.
 */
let cached: string | undefined;
let pending: Promise<string | null> | null = null;

function fetchLogin(): Promise<string | null> {
  pending ??= Promise.resolve()
    .then(() => window.electronAPI.github.checkStatus())
    .then((status) => (status.authenticated && status.username) || null)
    .catch(() => null)
    .then((login) => {
      pending = null;
      if (login) cached = login;
      return login;
    });
  return pending;
}

/** The GitHub login, or `null` while unknown or when there is none. */
export function useGitHubLogin(): string | null {
  const [login, setLogin] = useState<string | null>(cached ?? null);

  useMountEffect(() => {
    if (cached) return;
    let live = true;
    void fetchLogin().then((l) => {
      if (live) setLogin(l);
    });
    return () => {
      live = false;
    };
  });

  return login;
}
