/**
 * The fixtures are real transcripts from a developer's machine, scrubbed.
 * The repo is public, so this fails if anything identifying survived: the
 * machine's user, home and host, an email, a token, or a uuid that isn't a
 * fake one.
 *
 * One check runs only where the fixtures were made: against hashes of
 * distinctive source tokens the scrub replaced, written by
 * `scripts/scrub-transcript.ts --leaks`. A short hash of a word or path
 * segment can be guessed from a dictionary, so the list is never
 * committed: it is read from `$MANOR_FIXTURE_LEAK_HASHES`, else the
 * gitignored `__fixtures__/leak-hashes.local.json`, and skipped without.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { keptVocabulary, leakHash, LOCAL_LEAK_HASHES, TOKEN_CUTS } from "../../../scripts/scrub-transcript";

const FIXTURES = path.join(__dirname, "..", "__fixtures__");
const LEAK_HASHES =
  process.env.MANOR_FIXTURE_LEAK_HASHES || path.join(__dirname, "..", "..", "..", LOCAL_LEAK_HASHES);

/** Every fixture and golden, by name. */
function files(dir = FIXTURES): { name: string; text: string }[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return files(p);
    if (d.name.endsWith(".local.json")) return [];
    return [{ name: path.relative(FIXTURES, p), text: fs.readFileSync(p, "utf8") }];
  });
}

/** Names too common to mean this machine: CI runners, containers. */
const GENERIC = new Set(["root", "runner", "node", "ubuntu", "user", "admin", "localhost", "work", "repo"]);

function identity(): string[] {
  const out = new Set<string>(["orrybaram"]);
  const info = os.userInfo();
  out.add(info.username);
  out.add(info.homedir);
  out.add(os.hostname());
  out.add(os.hostname().split(".")[0]);
  try {
    const email = execFileSync("git", ["config", "user.email"], { encoding: "utf8" }).trim();
    if (email) {
      out.add(email);
      out.add(email.split("@")[0]);
    }
  } catch {
    // No git identity here: nothing to look for.
  }
  return [...out].filter((s) => s.length >= 4 && !GENERIC.has(s.toLowerCase()) && s !== "/");
}

const TOKEN_PATTERNS: [string, RegExp][] = [
  ["Anthropic/OpenAI key", /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/],
  ["Slack token", /\bxox[abpr]-[A-Za-z0-9-]{10,}/],
  ["AWS key", /\bAKIA[0-9A-Z]{16}\b/],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["JWT", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./],
];

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("fixture leak check", () => {
  const all = files();

  it("has fixtures to check, and keeps them small", () => {
    expect(all.length).toBeGreaterThan(0);
    const total = all.reduce((n, f) => n + Buffer.byteLength(f.text), 0);
    expect(total).toBeLessThan(400 * 1024);
  });

  it.each(identity())("never names this machine: %s", (needle) => {
    const re = new RegExp(`(^|[^A-Za-z0-9])${escape(needle)}($|[^A-Za-z0-9])`, "i");
    for (const f of all) expect(re.test(f.text), `${needle} in ${f.name}`).toBe(false);
  });

  it("carries no tokens or keys", () => {
    for (const f of all) {
      for (const [what, re] of TOKEN_PATTERNS) expect(re.test(f.text), `${what} in ${f.name}`).toBe(false);
    }
  });

  it("has only the placeholder email, cwd, home and uuids", () => {
    for (const f of all) {
      for (const m of f.text.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)) {
        expect(m[0], f.name).toBe("user@example.com");
      }
      for (const m of f.text.matchAll(/"cwd":"([^"]*)"/g)) expect(m[1], f.name).toMatch(/^\/work\/repo\d*(\/|$)/);
      for (const m of f.text.matchAll(/\/(?:home|Users)\/([^/"\\\s]+)/g)) expect(m[1], f.name).toMatch(/^d\d+$/);
      expect(/manor/i.test(f.text), `"manor" in ${f.name}`).toBe(false);
      // Every uuid is a remapped one.
      for (const m of f.text.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)) {
        expect(m[0], f.name).toMatch(/^00000000-0000-4000-8000-[0-9a-f]{12}$/);
      }
    }
  });

  // The scrub shifts every time so the first is 2026-01-01; a fixture spans
  // days, so anything outside this window is a real time it missed.
  const WINDOW = [Date.UTC(2025, 8, 1), Date.UTC(2026, 3, 1)];
  const inWindow = (ms: number) => ms >= WINDOW[0] && ms < WINDOW[1];

  it("has no wall-clock epoch the scrub didn't shift", () => {
    for (const f of all) {
      for (const m of f.text.matchAll(/(?<!\d)(\d{13}|\d{10})(?!\d)/g)) {
        const n = Number(m[1]);
        const ms = m[1].length === 13 ? n : n * 1000;
        if (ms < Date.UTC(2020, 0, 1) || ms >= Date.UTC(2036, 0, 1)) continue;
        expect(inWindow(ms), `epoch ${m[1]} in ${f.name}`).toBe(true);
      }
    }
  });

  it("has no date the scrub didn't shift", () => {
    for (const f of all) {
      for (const m of f.text.matchAll(/(?<![\d-])(\d{4})-(\d{2})-(\d{2})(?![\d-])/g)) {
        const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
        expect(inWindow(ms), `date ${m[0]} in ${f.name}`).toBe(true);
      }
    }
  });

  it.skipIf(!fs.existsSync(LEAK_HASHES))("contains none of the distinctive source tokens the scrub replaced", () => {
    const hashes = new Set<string>(JSON.parse(fs.readFileSync(LEAK_HASHES, "utf8")) as string[]);
    expect(hashes.size).toBeGreaterThan(100);
    // A token the fixtures keep by rule (a key, an enum) is schema, not a leak.
    // So is the parser's own text in a golden.
    const kept = keptVocabulary(all.flatMap((f) => f.text.split("\n")));
    for (const word of ["Conversation", "compacted", "Interrupted"]) kept.add(word);
    // The scrub replaces words, ids and path segments: try each cut.
    for (const f of all) {
      for (const re of TOKEN_CUTS) {
        for (const m of f.text.matchAll(re)) {
          if (kept.has(m[0])) continue;
          expect(hashes.has(leakHash(m[0])), `a replaced source token survived in ${f.name}`).toBe(false);
        }
      }
    }
  });
});
