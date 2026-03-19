import * as pty from "node-pty";
import type { BrowserWindow } from "electron";
import { ShellManager } from "./shell";

interface PtySession {
  process: pty.IPty;
}

export class PtyManager {
  private sessions = new Map<string, PtySession>();

  create(window: BrowserWindow, paneId: string, cwd: string | null, cols: number, rows: number): void {
    const zdotdir = ShellManager.zdotdirPath();
    const histfile = ShellManager.historyFileFor(paneId);

    const shell = process.env.SHELL || "/bin/zsh";

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      MANOR_PANE_ID: paneId,
      TERM: "xterm-256color",
      ZDOTDIR: zdotdir,
      REAL_ZDOTDIR: process.env.ZDOTDIR || process.env.HOME || "",
      MANOR_HISTFILE: histfile,
    };

    const ptyProcess = pty.spawn(shell, [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: cwd || process.env.HOME || "/",
      env,
    });

    // OSC 7 parsing state
    let oscBuf: number[] = [];
    let inOsc7 = false;

    ptyProcess.onData((data: string) => {
      // Scan for OSC 7 sequences to track CWD
      for (let i = 0; i < data.length; i++) {
        const byte = data.charCodeAt(i);

        if (inOsc7) {
          if (byte === 0x07) {
            // BEL terminator
            const payload = String.fromCharCode(...oscBuf);
            this.extractOsc7Cwd(window, paneId, payload);
            oscBuf = [];
            inOsc7 = false;
          } else if (byte === 0x1b) {
            // ESC (possible ST terminator)
            const payload = String.fromCharCode(...oscBuf);
            this.extractOsc7Cwd(window, paneId, payload);
            oscBuf = [];
            inOsc7 = false;
          } else {
            oscBuf.push(byte);
            if (oscBuf.length > 4096) {
              oscBuf = [];
              inOsc7 = false;
            }
          }
        } else if (byte === 0x1b) {
          oscBuf = [byte];
        } else if (oscBuf.length === 1 && oscBuf[0] === 0x1b && byte === 0x5d /* ] */) {
          oscBuf.push(byte);
        } else if (oscBuf.length === 2 && byte === 0x37 /* 7 */) {
          oscBuf.push(byte);
        } else if (oscBuf.length === 3 && byte === 0x3b /* ; */) {
          oscBuf = [];
          inOsc7 = true;
        } else {
          oscBuf = [];
        }
      }

      window.webContents.send(`pty-output-${paneId}`, data);
    });

    ptyProcess.onExit(() => {
      window.webContents.send(`pty-exit-${paneId}`);
      this.sessions.delete(paneId);
    });

    this.sessions.set(paneId, { process: ptyProcess });
  }

  write(paneId: string, data: string): void {
    this.sessions.get(paneId)?.process.write(data);
  }

  resize(paneId: string, cols: number, rows: number): void {
    this.sessions.get(paneId)?.process.resize(cols, rows);
  }

  close(paneId: string): void {
    const session = this.sessions.get(paneId);
    if (session) {
      session.process.kill();
      this.sessions.delete(paneId);
    }
  }

  private extractOsc7Cwd(window: BrowserWindow, paneId: string, payload: string): void {
    // Format: file://hostname/path or file:///path
    if (!payload.startsWith("file://")) return;
    const rest = payload.slice(7);
    const slashIdx = rest.indexOf("/");
    const path = slashIdx >= 0 ? rest.slice(slashIdx) : rest;
    const decoded = decodeURIComponent(path);
    window.webContents.send(`pty-cwd-${paneId}`, decoded);
  }
}
