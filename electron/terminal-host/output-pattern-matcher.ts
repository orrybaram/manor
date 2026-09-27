/**
 * Output pattern matcher — moved into the Pane facts extractor
 * (`pane-facts.ts`, ADR-184 §3), which reports its matches as raw output
 * hints. Re-exported here for the old `AgentDetector` fallback path in
 * `session.ts` and for `stripAnsi`'s other users, until ADR-184 ticket 4
 * deletes that path.
 */

export { OutputPatternMatcher, stripAnsi } from "./pane-facts";
