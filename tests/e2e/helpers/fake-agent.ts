import path from "path";

/**
 * The fake agent CLI the e2e suite points projects at.
 *
 * The script itself is `fake-agent.sh` next to this file — a real script, not
 * a string built here. It needs no per-test state, so nothing is generated or
 * copied: tests hand its path to Manor as a project's agent command.
 */

/** Absolute path to the script. Quote it when embedding in a shell command. */
export const FAKE_AGENT = path.join(__dirname, "fake-agent.sh");

/** Printed once at startup. Assert on this to know the session is live. */
export const FAKE_AGENT_BANNER = "fake-agent ready";

/** Prefix the fake agent echoes back for anything sent to it. */
export const FAKE_AGENT_ECHO = "received:";

/**
 * Send this and the agent ends its turn without asking for anything back, so
 * the session parks in `responded` rather than `requires_input`. Any other
 * message re-arms the permission prompt.
 */
export const FAKE_AGENT_HUSH = "hush";
