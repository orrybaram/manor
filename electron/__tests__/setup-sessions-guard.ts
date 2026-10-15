/**
 * Vitest setup: fail fast when a test reads the default sessions directory
 * (#310).
 *
 * `setup-isolated-home.ts` plants `~/.manor/sessions` as a plain file, which
 * trips any write there with ENOTDIR. The static readers swallow every error
 * and answer "not found", so a read would pass silently against the wrong
 * directory. Wrap them so a call without an explicit temp dir throws outside
 * their try/catch.
 *
 * Plain reassignment, not `vi.spyOn`: a test's `vi.restoreAllMocks()` must
 * not lift the guard.
 */
import * as path from "node:path";
import { SESSIONS_DIR, ScrollbackWriter } from "../terminal-host/scrollback";

function assertNotDefault(reader: string, sessionsDir: string | undefined) {
  if (sessionsDir === undefined || path.resolve(sessionsDir) === SESSIONS_DIR) {
    throw new Error(
      `ScrollbackWriter.${reader} read the default sessions dir; pass a temp dir (#310)`,
    );
  }
}

const { readMeta, readScrollback, isUncleanShutdown, listPersistedSessions } =
  ScrollbackWriter;

ScrollbackWriter.readMeta = (sessionId, sessionsDir) => {
  assertNotDefault("readMeta", sessionsDir);
  return readMeta.call(ScrollbackWriter, sessionId, sessionsDir);
};
ScrollbackWriter.readScrollback = (sessionId, sessionsDir) => {
  assertNotDefault("readScrollback", sessionsDir);
  return readScrollback.call(ScrollbackWriter, sessionId, sessionsDir);
};
ScrollbackWriter.isUncleanShutdown = (sessionId, sessionsDir) => {
  assertNotDefault("isUncleanShutdown", sessionsDir);
  return isUncleanShutdown.call(ScrollbackWriter, sessionId, sessionsDir);
};
ScrollbackWriter.listPersistedSessions = (sessionsDir) => {
  assertNotDefault("listPersistedSessions", sessionsDir);
  return listPersistedSessions.call(ScrollbackWriter, sessionsDir);
};
