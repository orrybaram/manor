import { describe, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TERMINAL_HOST_PROTOCOL } from "./types";
import { PTY_SUBPROCESS_PROTOCOL } from "./pty-subprocess-ipc";

/**
 * Guards ADR-185 §B.5. With app-version daemon restarts gone, the wire
 * protocol (`TERMINAL_HOST_PROTOCOL`, `types.ts`) and the pty-subprocess frame
 * protocol (`PTY_SUBPROCESS_PROTOCOL`, `pty-subprocess-ipc.ts`) are the only
 * signal left that an old daemon can no longer serve a new client. This test
 * records a hash of each protocol-bearing source alongside the constant it
 * was hashed at (`__fixtures__/protocol-guard.json`) and fails whenever the
 * source changed but the constant did not — the case a forgotten bump would
 * otherwise ship silently.
 *
 * Normalization strips `//` and `/* *\/` comments, then collapses all
 * whitespace, so reformatting or re-commenting a file never trips the guard.
 * The `..._PROTOCOL = N` declaration line itself is dropped before hashing —
 * bumping it is exactly the change this test asks for, not a violation of it.
 *
 * Hashing the whole file (rather than just the protocol type declarations) is
 * deliberately blunt: an edit to `types.ts` or `pty-subprocess-ipc.ts` that
 * has nothing to do with either protocol also trips this guard. That is an
 * accepted false positive; re-record with
 * `UPDATE_PROTOCOL_GUARD=1 npx vitest run electron/terminal-host/protocol-guard`.
 */

interface FixtureEntry {
  protocol: number;
  hash: string;
}

interface Fixture {
  wire: FixtureEntry;
  pty: FixtureEntry;
}

const FIXTURE_PATH = join(__dirname, "__fixtures__", "protocol-guard.json");
const RERECORD_CMD =
  "UPDATE_PROTOCOL_GUARD=1 npx vitest run electron/terminal-host/protocol-guard";

/** Strips comments, then the const's own declaration line, then whitespace. */
function normalize(source: string, constName: string): string {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  const constLine = new RegExp(`\\b${constName}\\s*=`);
  const withoutConstLine = withoutComments
    .split("\n")
    .filter((line) => !constLine.test(line))
    .join("\n");
  return withoutConstLine.replace(/\s+/g, "");
}

function hashOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function readFixture(): Fixture {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf-8")) as Fixture;
}

function writeFixtureEntry(key: keyof Fixture, entry: FixtureEntry): void {
  const fixture = readFixture();
  fixture[key] = entry;
  writeFileSync(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`);
}

function checkContract(params: {
  key: keyof Fixture;
  file: string;
  constName: string;
  constValue: number;
}): void {
  const { key, file, constName, constValue } = params;
  const source = readFileSync(join(__dirname, file), "utf-8");
  const hash = hashOf(normalize(source, constName));

  if (process.env.UPDATE_PROTOCOL_GUARD) {
    writeFixtureEntry(key, { protocol: constValue, hash });
    return;
  }

  const fixture = readFixture()[key];
  const hashChanged = hash !== fixture.hash;
  const constantChanged = constValue !== fixture.protocol;

  if (!hashChanged && !constantChanged) return;

  if (hashChanged && !constantChanged) {
    throw new Error(
      `${file} changed but ${constName} was not bumped. If the change affects ` +
        `the daemon contract (ADR-185), bump ${constName}. Otherwise re-record ` +
        `with \`${RERECORD_CMD}\`.`,
    );
  }

  // The constant changed (with or without a further source change) but the
  // fixture was not re-recorded to match, so it no longer reflects reality.
  throw new Error(
    `${constName} changed but the protocol-guard fixture was not re-recorded. ` +
      `Re-record with \`${RERECORD_CMD}\`.`,
  );
}

describe("protocol guard (ADR-185 §B.5)", () => {
  it("wire: types.ts protocol-bearing source matches TERMINAL_HOST_PROTOCOL", () => {
    checkContract({
      key: "wire",
      file: "types.ts",
      constName: "TERMINAL_HOST_PROTOCOL",
      constValue: TERMINAL_HOST_PROTOCOL,
    });
  });

  it("pty: pty-subprocess-ipc.ts protocol-bearing source matches PTY_SUBPROCESS_PROTOCOL", () => {
    checkContract({
      key: "pty",
      file: "pty-subprocess-ipc.ts",
      constName: "PTY_SUBPROCESS_PROTOCOL",
      constValue: PTY_SUBPROCESS_PROTOCOL,
    });
  });
});
