#!/usr/bin/env node
/**
 * ADR-215 ticket 1 spike: which keystrokes answer Claude Code's pickers?
 *
 * Runs the real `claude` CLI (haiku, to keep it cheap) in a PTY, has it call
 * AskUserQuestion / ExitPlanMode with a known shape, types a candidate key
 * sequence, and reads the resulting tool_result from the session transcript
 * under ~/.claude/projects. Stops at the first candidate that works per case.
 *
 * Rerun this when Claude Code's picker changes, and re-pin the sequences in
 * electron/chat-mirror/picker-keys.ts.
 *
 * node-pty is built for Electron's ABI, so run it under Electron-as-node:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/spike-picker-keys.mjs [case ...]
 *
 * Writes a JSON report (screens before/after each attempt) to the OS temp dir.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import pty from "node-pty";
import xterm from "@xterm/headless";

const { Terminal } = xterm;

const KEY = {
  down: "\x1b[B",
  up: "\x1b[A",
  right: "\x1b[C",
  left: "\x1b[D",
  enter: "\r",
  space: " ",
  tab: "\t",
  esc: "\x1b",
};

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const opts = (labels) => labels.map((label) => ({ label, description: `${label} option` }));

/** Each case: how to start claude, what to ask, which key sequences to try, how to judge the result. */
const CASES = [
  {
    name: "single",
    tool: "AskUserQuestion",
    input: (n) => ({
      questions: [{ question: `Pick a fruit (${n})`, header: "Fruit", multiSelect: false, options: opts(["Apple", "Banana", "Cherry"]) }],
    }),
    waitFor: "Cherry",
    candidates: [
      ["down", "down", "enter"],
      ["3"],
      ["3", "enter"],
    ],
    ok: (r) => r.includes('="Cherry"'),
  },
  {
    name: "other",
    tool: "AskUserQuestion",
    input: (n) => ({
      questions: [{ question: `Pick a fruit (${n})`, header: "Fruit", multiSelect: false, options: opts(["Apple", "Banana", "Cherry"]) }],
    }),
    waitFor: "Cherry",
    candidates: [
      ["down", "down", "down", { text: "zebra" }, "enter"],
      ["down", "down", "down", "enter", { text: "zebra" }, "enter"],
      ["4", { text: "zebra" }, "enter"],
    ],
    ok: (r) => r.includes("zebra"),
  },
  {
    name: "multi",
    tool: "AskUserQuestion",
    input: (n) => ({
      questions: [{ question: `Pick fruits (${n})`, header: "Fruits", multiSelect: true, options: opts(["Apple", "Banana", "Cherry"]) }],
    }),
    waitFor: "Cherry",
    candidates: [
      ["space", "down", "down", "space", "enter"],
      ["enter", "down", "down", "enter", "down", "down", "enter"],
      ["space", "down", "down", "space", "down", "down", "enter"],
      ["enter", "down", "down", "enter", "tab", "enter"],
    ],
    ok: (r) => r.includes("Apple") && r.includes("Cherry") && !r.includes("Banana"),
  },
  {
    name: "two-questions",
    tool: "AskUserQuestion",
    input: (n) => ({
      questions: [
        { question: `Pick a fruit (${n})`, header: "Fruit", multiSelect: false, options: opts(["Apple", "Banana", "Cherry"]) },
        { question: `Pick a colour (${n})`, header: "Colour", multiSelect: false, options: opts(["Red", "Green", "Blue"]) },
      ],
    }),
    waitFor: "Cherry",
    candidates: [
      ["down", "enter", "enter", "enter"],
      ["down", "enter", "enter", "1"],
      ["down", "enter", "enter", { wait: 1000 }, "enter"],
    ],
    ok: (r) => r.includes('="Banana"') && r.includes('="Red"'),
  },
  {
    name: "plan-approve",
    tool: "ExitPlanMode",
    planMode: true,
    waitFor: "plan",
    candidates: [["enter"], ["1"]],
    ok: (r) => /approved/i.test(r),
  },
  {
    name: "plan-reject",
    tool: "ExitPlanMode",
    planMode: true,
    waitFor: "plan",
    candidates: [
      ["down", "down", "enter"],
      ["down", "down", "down", "enter"],
      ["3"],
      ["esc"],
    ],
    ok: (r) => !/approved/i.test(r),
  },
  // Not a picker: how a multi-line chat message must be typed so it arrives
  // as ONE prompt. Candidates are chunks written with a pause between them.
  {
    name: "multiline",
    send: true,
    candidates: [
      // One write, as chat.send does today.
      [(n) => `alpha-${n}\nbeta-${n}\r`],
      [(n) => `alpha-${n}\nbeta-${n}`, "\r"],
      [(n) => `\x1b[200~alpha-${n}\nbeta-${n}\x1b[201~`, "\r"],
      [(n) => `alpha-${n}\\\rbeta-${n}`, "\r"],
    ],
  },
];

function cleanEnv() {
  const env = { ...process.env };
  // Never let these sessions report into Manor as agents, and don't look
  // like a nested Claude Code session.
  for (const k of Object.keys(env)) {
    if (k.startsWith("MANOR_") || k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_") || k === "ELECTRON_RUN_AS_NODE") {
      delete env[k];
    }
  }
  return env;
}

function promptFor(c, nonce) {
  if (c.send) return `Spike ${nonce}. Reply with only "ok" to this and every later message.`;
  if (c.tool === "ExitPlanMode") {
    return `Spike ${nonce}. Do not read or search any files. Immediately call ExitPlanMode with the plan "Create hello.txt containing hi". Nothing else.`;
  }
  return `Spike ${nonce}. Call the AskUserQuestion tool exactly once with exactly this input, and do nothing else: ${JSON.stringify(c.input(nonce))}. After it returns, reply with only "done".`;
}

/** The transcript whose text contains the nonce, among files touched since `since`. */
function findTranscript(nonce, since) {
  const root = path.join(os.homedir(), ".claude", "projects");
  let dirs;
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return null;
  }
  for (const d of dirs) {
    let files;
    try {
      files = fs.readdirSync(path.join(root, d));
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const p = path.join(root, d, f);
      try {
        if (fs.statSync(p).mtimeMs < since) continue;
        if (fs.readFileSync(p, "utf8").includes(nonce)) return p;
      } catch {
        // raced with a write; try next poll
      }
    }
  }
  return null;
}

/** The text of every user prompt in the transcript (tool results excluded). */
function readUserTexts(file) {
  const out = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d.type !== "user" || d.isMeta) continue;
    const c = d.message?.content;
    if (typeof c === "string") out.push(c);
    else if (Array.isArray(c)) {
      const text = c.filter((b) => b.type === "text").map((b) => b.text).join("");
      if (text) out.push(text);
    }
  }
  return out;
}

function countAssistant(file) {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.includes('"type":"assistant"')).length;
}

/** { useId, result } for the first `tool` call in the transcript. */
function readToolState(file, tool) {
  let useId = null;
  let result = null;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const content = d.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b.type === "tool_use" && b.name === tool && !useId) useId = b.id;
      if (b.type === "tool_result" && useId && b.tool_use_id === useId) {
        result = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
      }
    }
  }
  return { useId, result };
}

function screenText(term) {
  const buf = term.buffer.active;
  const out = [];
  for (let i = 0; i < buf.length; i++) out.push(buf.getLine(i)?.translateToString(true) ?? "");
  // Last screenful, trailing blank lines dropped.
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.slice(-term.rows).join("\n");
}

async function sendKeys(proc, seq) {
  for (const k of seq) {
    if (typeof k === "object" && "text" in k) proc.write(k.text);
    else if (typeof k === "object" && "wait" in k) await delay(k.wait);
    else proc.write(KEY[k] ?? k);
    await delay(250);
  }
}

/** The new-folder trust dialog defaults to "No, exit": move to "Yes" first. True if it was on screen. */
function handleTrust(proc, screen) {
  if (!/Yes, I trust this folder/.test(screen)) return false;
  proc.write(/❯\s*Yes, I trust this folder/.test(screen) ? KEY.enter : KEY.down);
  return true;
}

async function attemptSend(c, chunks, { proc, term, nonce, since, deadline, rec }) {
  // 1. Wait for Claude to answer the opening prompt, so the input is idle.
  let file = null;
  while (Date.now() < deadline) {
    await delay(1000);
    if (handleTrust(proc, screenText(term))) continue;
    file ??= findTranscript(nonce, since);
    if (file && countAssistant(file) > 0) break;
  }
  if (!file || countAssistant(file) === 0) {
    rec.error = "no reply appeared";
    rec.screenBefore = screenText(term);
    return rec;
  }
  await delay(2000);
  rec.screenBefore = screenText(term);

  // 2. Type the message, then give a split second prompt time to show up.
  for (const chunk of chunks) {
    proc.write(typeof chunk === "function" ? chunk(nonce) : chunk);
    await delay(400);
  }
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    await delay(500);
    if (readUserTexts(file).some((t) => t.includes(`beta-${nonce}`))) break;
  }
  await delay(5000);
  rec.screenAfter = screenText(term);
  const hits = readUserTexts(file).filter((t) => t.includes(`alpha-${nonce}`) || t.includes(`beta-${nonce}`));
  rec.result = JSON.stringify(hits);
  rec.ok = hits.length === 1 && /alpha-\S+\s*\n\s*beta-/.test(hits[0]);
  if (hits.length === 0) rec.error = "message never arrived";
  return rec;
}

async function attempt(c, seq) {
  const nonce = `n${crypto.randomBytes(4).toString("hex")}`;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "manor-picker-spike-"));
  const term = new Terminal({ cols: 120, rows: 40, allowProposedApi: true });
  const args = ["--model", "haiku"];
  if (c.planMode) args.push("--permission-mode", "plan");
  args.push(promptFor(c, nonce));

  const since = Date.now() - 1000;
  const proc = pty.spawn("claude", args, { name: "xterm-256color", cols: 120, rows: 40, cwd, env: cleanEnv() });
  proc.onData((d) => term.write(d));

  const rec = { case: c.name, keys: seq, nonce, ok: false };
  try {
    const deadline = Date.now() + 45_000;
    let file = null;
    let state = { useId: null, result: null };

    if (c.send) return await attemptSend(c, seq, { proc, term, nonce, since, deadline, rec });

    // 1. Wait for the picker's tool_use to land in the transcript and draw.
    while (Date.now() < deadline) {
      await delay(1000);
      const screen = screenText(term);
      // Re-checked each tick: keys sent before the TUI listens are lost.
      if (handleTrust(proc, screen)) continue;
      file ??= findTranscript(nonce, since);
      if (file) state = readToolState(file, c.tool);
      if (state.useId && screen.toLowerCase().includes(c.waitFor.toLowerCase())) break;
    }
    if (!state.useId) {
      rec.error = `no ${c.tool} call appeared`;
      rec.screenBefore = screenText(term);
      return rec;
    }
    await delay(1000);
    rec.screenBefore = screenText(term);

    // 2. Type the candidate, then wait for its tool_result.
    await sendKeys(proc, seq);
    const resultDeadline = Date.now() + 20_000;
    while (Date.now() < resultDeadline) {
      await delay(500);
      state = readToolState(file, c.tool);
      if (state.result !== null) break;
    }
    rec.screenAfter = screenText(term);
    rec.result = state.result;
    rec.ok = state.result !== null && c.ok(state.result);
    if (state.result === null) rec.error = "no tool_result within 20s";
    return rec;
  } finally {
    try {
      proc.kill("SIGKILL");
    } catch {
      // already gone
    }
    term.dispose();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

async function main() {
  const only = process.argv.slice(2);
  const cases = only.length ? CASES.filter((c) => only.includes(c.name)) : CASES;
  const version = execFileSync("claude", ["--version"], { encoding: "utf8", env: cleanEnv() }).trim();
  console.log(`Claude Code ${version}\n`);

  const report = { version, date: new Date().toISOString(), attempts: [] };
  const summary = [];
  for (const c of cases) {
    let winner = null;
    for (const seq of c.candidates) {
      process.stdout.write(`${c.name.padEnd(14)} ${JSON.stringify(seq.map((k) => (typeof k === "function" ? k("N") : k)))} … `);
      const rec = await attempt(c, seq);
      report.attempts.push(rec);
      console.log(rec.ok ? "OK" : `no (${rec.error ?? `result: ${String(rec.result).slice(0, 80)}`})`);
      if (rec.error?.endsWith("appeared")) {
        // Setup failed, not the keys: every other attempt would fail the same way.
        console.log(`\nClaude never reached the picker. Its screen was:\n${"-".repeat(60)}\n${rec.screenBefore}\n${"-".repeat(60)}`);
        process.exit(1);
      }
      if (rec.ok) {
        winner = seq;
        break;
      }
    }
    summary.push({ case: c.name, keys: winner });
  }

  const out = path.join(os.tmpdir(), `manor-picker-spike-${Date.now()}.json`);
  report.summary = summary;
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log("\nSummary:");
  for (const s of summary) console.log(`  ${s.case.padEnd(14)} ${s.keys ? JSON.stringify(s.keys.map((k) => (typeof k === "function" ? k("N") : k))) : "NOT FOUND"}`);
  console.log(`\nReport (with screens): ${out}`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
