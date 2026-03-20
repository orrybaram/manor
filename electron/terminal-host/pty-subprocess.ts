#!/usr/bin/env node
/**
 * PTY subprocess — owns a single PTY instance.
 *
 * Communicates with the daemon over stdin/stdout using the binary frame protocol.
 * Each PTY runs in its own child process for isolation.
 */

import * as pty from "node-pty";
import * as fs from "node:fs";
import {
  MSG,
  FrameDecoder,
  encodeFrame,
  type MessageType,
} from "./pty-subprocess-ipc";
import type { PtySpawnPayload } from "./types";
import treeKill from "tree-kill";

let ptyProcess: pty.IPty | null = null;
let disposed = false;
let fgProcInterval: ReturnType<typeof setInterval> | null = null;
let lastFgProcName: string | null = null;

const KNOWN_SHELLS = new Set(["zsh", "bash", "fish", "sh"]);

// ── Output batching ──
// Batch PTY output to reduce frame overhead on high-throughput output
let outputBatch: Buffer[] = [];
let outputTimer: ReturnType<typeof setTimeout> | null = null;
const OUTPUT_BATCH_INTERVAL_MS = 4;
const OUTPUT_BATCH_MAX_BYTES = 64 * 1024;
let outputBatchSize = 0;

function flushOutput(): void {
  if (outputBatch.length === 0) return;
  const combined = Buffer.concat(outputBatch);
  outputBatch = [];
  outputBatchSize = 0;
  if (outputTimer) {
    clearTimeout(outputTimer);
    outputTimer = null;
  }
  writeFrame(MSG.DATA, combined);
}

function enqueueOutput(data: Buffer): void {
  outputBatch.push(data);
  outputBatchSize += data.length;

  if (outputBatchSize >= OUTPUT_BATCH_MAX_BYTES) {
    flushOutput();
    return;
  }

  if (!outputTimer) {
    outputTimer = setTimeout(flushOutput, OUTPUT_BATCH_INTERVAL_MS);
  }
}

// ── Write queue for stdout (async fs.write to avoid blocking) ──
let writing = false;
const writeQueue: Buffer[] = [];

function writeFrame(type: MessageType, payload?: Buffer | string): void {
  const frame = encodeFrame(type, payload);
  writeQueue.push(frame);
  drainWriteQueue();
}

function drainWriteQueue(): void {
  if (writing || writeQueue.length === 0) return;
  writing = true;

  const frame = writeQueue.shift()!;
  fs.write(1, frame, 0, frame.length, null, (err) => {
    writing = false;
    if (err) {
      if (!disposed) process.exit(1);
      return;
    }
    drainWriteQueue();
  });
}

// ── Frame decoder for stdin ──
const decoder = new FrameDecoder((type, payload) => {
  switch (type) {
    case MSG.SPAWN:
      handleSpawn(JSON.parse(payload.toString("utf-8")) as PtySpawnPayload);
      break;
    case MSG.WRITE:
      ptyProcess?.write(payload.toString("utf-8"));
      break;
    case MSG.RESIZE: {
      const { cols, rows } = JSON.parse(payload.toString("utf-8"));
      try {
        ptyProcess?.resize(cols, rows);
      } catch {
        // Ignore resize errors (process may have exited)
      }
      break;
    }
    case MSG.KILL:
      handleKill();
      break;
    case MSG.SIGNAL: {
      const { signal } = JSON.parse(payload.toString("utf-8"));
      if (ptyProcess) {
        try {
          process.kill(ptyProcess.pid, signal);
        } catch {
          // Process may already be dead
        }
      }
      break;
    }
    case MSG.DISPOSE:
      handleDispose();
      break;
  }
});

function pollForegroundProcess(): void {
  if (fgProcInterval) clearInterval(fgProcInterval);

  const shellBasename = ptyProcess?.process?.replace(/^-/, "") ?? "";

  fgProcInterval = setInterval(() => {
    if (disposed || !ptyProcess) return;

    // Use node-pty's .process property which uses proc_pidinfo on macOS
    // to correctly resolve the foreground process of the PTY, even when
    // the child has its own process group (interactive shell job control).
    const fgProc = ptyProcess.process;
    const basename = fgProc?.replace(/^-/, "") ?? "";

    // If the foreground process is the shell itself, report null
    const isShell =
      !basename || basename === shellBasename || KNOWN_SHELLS.has(basename);
    const fgName = isShell ? null : basename;

    // Only send if changed
    if (fgName !== lastFgProcName) {
      lastFgProcName = fgName;
      writeFrame(MSG.FGPROC, JSON.stringify({ name: fgName }));
    }
  }, 500);
}

function handleSpawn(payload: PtySpawnPayload): void {
  try {
    ptyProcess = pty.spawn(payload.shell, payload.args, {
      name: "xterm-256color",
      cols: payload.cols,
      rows: payload.rows,
      cwd: payload.cwd,
      env: payload.env,
    });

    const pid = ptyProcess.pid;
    writeFrame(MSG.SPAWNED, JSON.stringify({ pid }));

    // Start foreground process polling
    pollForegroundProcess();

    ptyProcess.onData((data: string) => {
      enqueueOutput(Buffer.from(data, "utf-8"));
    });

    ptyProcess.onExit(({ exitCode }) => {
      if (fgProcInterval) {
        clearInterval(fgProcInterval);
        fgProcInterval = null;
      }
      flushOutput();
      writeFrame(MSG.EXIT, JSON.stringify({ exitCode: exitCode ?? 0 }));
    });
  } catch (err) {
    writeFrame(MSG.ERROR, JSON.stringify({ message: String(err) }));
  }
}

function handleKill(): void {
  if (!ptyProcess) return;
  const pid = ptyProcess.pid;

  // SIGTERM first, escalate to SIGKILL after 5s
  treeKill(pid, "SIGTERM", (err) => {
    if (err) {
      // Process may already be dead
      return;
    }

    setTimeout(() => {
      try {
        // Check if still alive
        process.kill(pid, 0);
        // Still alive, force kill
        treeKill(pid, "SIGKILL");
      } catch {
        // Already dead
      }
    }, 5000);
  });
}

function handleDispose(): void {
  disposed = true;
  if (fgProcInterval) {
    clearInterval(fgProcInterval);
    fgProcInterval = null;
  }
  if (ptyProcess) {
    try {
      ptyProcess.kill();
    } catch {
      // ignore
    }
  }
  process.exit(0);
}

// ── Main ──

// Send ready signal
writeFrame(MSG.READY);

// Read from stdin
process.stdin.on("data", (chunk: Buffer) => {
  decoder.push(chunk);
});

process.stdin.on("end", () => {
  handleDispose();
});

process.on("SIGTERM", handleDispose);
process.on("SIGINT", handleDispose);
