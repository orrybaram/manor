/**
 * Bridge-level E2E against a real sshd (ADR-160 ticket 12, ADR-178 ticket 8).
 *
 * Everything else in the remote stack is tested against fakes; this drives a
 * real `SshTransport` + `TerminalHostClient` against a real box: cold
 * bootstrap, reinstall over a stale host, a session's whole lifecycle, the
 * remote hook journal across a dropped connection, snapshot resync after a
 * drop mid-output, and a remote daemon restart.
 *
 * Skipped unless MANOR_E2E_SSH=1 — `pnpm test:unit` never runs it. Run it
 * through the harness, which starts the sshd and builds the host tarball:
 *
 *   node scripts/test-remote-e2e.mjs --vitest-only            # macOS sshd
 *   node scripts/test-remote-e2e.mjs --vitest-only --docker   # Linux box
 *
 * The UI-level scenarios (notifications, pane recovery, port forwards) are in
 * tests/e2e/remote-host.spec.ts.
 */

import "../xterm-env-polyfill";
import * as fs from "node:fs";
import * as path from "node:path";
import { Terminal as HeadlessTerminal } from "@xterm/headless";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ensureRemoteHost, hostTarballPath } from "../../backend/remote-bootstrap";
import { TerminalHostClient } from "../client";
import { SshTransport } from "../transport-ssh";
import type { HookJournalEntry, StreamEvent } from "../types";
import {
  APP_TARGET,
  REMOTE_AGENT,
  installRemoteStubs,
  killAppSsh,
  onRemote,
  pollFor,
  remoteHome,
  remoteKind,
  remoteSkipReason,
  wipeRemote,
} from "../../../tests/e2e/helpers/remote-host";

const ROOT = path.resolve(__dirname, "..", "..", "..");
const VERSION = (
  JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8")) as { version: string }
).version;
const TARBALL = hostTarballPath(VERSION, path.join(ROOT, "dist-electron"));

const skipReason = remoteSkipReason();
if (skipReason && process.env.MANOR_E2E_SSH === "1") {
  // Asked for, but misconfigured: say so rather than skip silently.
  throw new Error(skipReason);
}

/** node-pty compiles from source on Linux during the first bootstrap. */
const BOOTSTRAP_TIMEOUT_MS = remoteKind() === "docker" ? 15 * 60_000 : 5 * 60_000;
const STEP_TIMEOUT_MS = 60_000;

/** One client over one transport, with every stream event it saw. */
interface Harness {
  client: TerminalHostClient;
  transport: SshTransport;
  events: StreamEvent[];
  /** Whether the last `ensureRemoteHost` installed (true) or found the host (false). */
  installed: () => boolean | null;
  lost: number;
  reconnected: string[][];
  /** While true, the reconnect loop waits (a closed lid); flip and `retryReconnectNow`. */
  hold: boolean;
}

function createHarness(): Harness {
  let installed: boolean | null = null;
  const transport = new SshTransport(APP_TARGET, {
    ensureRemoteHost: async (target, _version, exec) => {
      const result = await ensureRemoteHost(target, VERSION, exec, {
        loadTarball: () => fs.readFileSync(TARBALL),
      });
      installed = result.installed;
    },
  });
  const client = new TerminalHostClient(VERSION, transport, { pushLocalEnv: false });
  const h: Harness = {
    client,
    transport,
    events: [],
    installed: () => installed,
    lost: 0,
    reconnected: [],
    hold: false,
  };
  client.setReconnectPolicy((attempt) => (h.hold ? 10 * 60_000 : Math.min(250 * 2 ** attempt, 2_000)));
  client.setConnectionListener({
    onLost: () => {
      h.lost++;
    },
    onReconnected: ({ sessionIds }) => {
      h.reconnected.push(sessionIds);
    },
  });
  client.onEvent((event) => {
    h.events.push(event);
  });
  return h;
}

function dataFor(h: Harness, sessionId: string): string {
  return h.events
    .filter((e): e is Extract<StreamEvent, { type: "data" }> => e.type === "data" && e.sessionId === sessionId)
    .map((e) => e.data)
    .join("");
}

function waitForOutput(h: Harness, sessionId: string, needle: string | RegExp): Promise<string> {
  return pollFor(
    `${String(needle)} in ${sessionId}`,
    () => {
      const out = dataFor(h, sessionId);
      return (typeof needle === "string" ? out.includes(needle) : needle.test(out)) ? out : null;
    },
    STEP_TIMEOUT_MS,
  );
}

/** A fresh shell on the box, at a prompt. */
async function openShell(h: Harness, sessionId: string, home: string): Promise<void> {
  await h.client.createOrAttach(sessionId, home, 80, 24);
  // Echo a marker computed by the shell, so the typed line itself cannot
  // match. zsh drops what is typed while it is still starting up, so retype
  // until it answers (see awaitShellReady in tests/e2e/helpers/terminal.ts).
  for (let attempt = 0; attempt < 20; attempt++) {
    h.client.writeNoAck(sessionId, "echo READY_$((20+22))\n");
    const answered = await pollFor(
      "READY_42",
      () => (dataFor(h, sessionId).includes("READY_42") ? true : null),
      3_000,
    ).catch(() => false);
    if (answered) return;
  }
  throw new Error(`the shell in ${sessionId} never answered`);
}

function hookEvents(h: Harness): Extract<StreamEvent, { type: "hookEvent" }>[] {
  return h.events.filter(
    (e): e is Extract<StreamEvent, { type: "hookEvent" }> => e.type === "hookEvent",
  );
}

describe.skipIf(skipReason !== null)("remote host over a real sshd", () => {
  let h: Harness;
  let home: string;

  beforeAll(() => {
    if (!fs.existsSync(TARBALL)) {
      throw new Error(
        `${TARBALL} is missing — run \`pnpm build && node scripts/build-host-tarball.mjs\` ` +
          "(scripts/test-remote-e2e.mjs does both unless --no-build).",
      );
    }
    wipeRemote();
    installRemoteStubs();
    home = remoteHome();
  }, STEP_TIMEOUT_MS);

  afterAll(async () => {
    await h?.client.dispose();
  });

  it(
    "cold-bootstraps an empty remote home, then connects",
    async () => {
      expect(onRemote('test -e "$HOME/.manor/bin/manor-host"', { allowFailure: true }).code).not.toBe(0);

      h = createHarness();
      await h.client.connect();

      expect(h.installed()).toBe(true);
      expect(onRemote('"$HOME/.manor/bin/manor-host" --version').stdout.trim()).toBe(VERSION);
      expect(await h.client.ping()).toBe(true);
      // The agent-hook bootstrap ran on the box, against the box's own home.
      expect(await h.client.bootstrap()).not.toBeNull();
      onRemote('test -x "$HOME/.manor/hooks/notify.sh"');
    },
    BOOTSTRAP_TIMEOUT_MS,
  );

  it(
    "reinstalls over a stale host version, then connects",
    async () => {
      await h.client.dispose();
      onRemote(
        'sed -i.bak "s/^MANOR_VERSION=.*/MANOR_VERSION=0.0.0-stale/" "$HOME/.manor/bin/manor-host" && ' +
          'rm -f "$HOME/.manor/bin/manor-host.bak"',
      );
      expect(onRemote('"$HOME/.manor/bin/manor-host" --version').stdout.trim()).toBe("0.0.0-stale");

      h = createHarness();
      await h.client.connect();

      expect(h.installed()).toBe(true);
      expect(onRemote('"$HOME/.manor/bin/manor-host" --version').stdout.trim()).toBe(VERSION);
      expect(await h.client.ping()).toBe(true);

      // And a reconnect with nothing stale skips the install.
      await h.client.dispose();
      h = createHarness();
      await h.client.connect();
      expect(h.installed()).toBe(false);
    },
    BOOTSTRAP_TIMEOUT_MS,
  );

  it(
    "creates a session, writes, reads output back, resizes and kills it",
    async () => {
      const sid = `e2e-life-${Date.now()}`;
      await openShell(h, sid, home);

      h.client.writeNoAck(sid, "echo MANOR_$((6*7))_OK\n");
      await waitForOutput(h, sid, "MANOR_42_OK");

      await h.client.resize(sid, 100, 30);
      h.client.writeNoAck(sid, "stty size\n");
      await waitForOutput(h, sid, /\b30 100\b/);

      expect((await h.client.listSessions()).some((s) => s.sessionId === sid)).toBe(true);
      await h.client.kill(sid);
      await pollFor(
        `${sid} gone`,
        async () => ((await h.client.listSessions()).some((s) => s.sessionId === sid) ? null : true),
        STEP_TIMEOUT_MS,
      );
    },
    2 * STEP_TIMEOUT_MS,
  );

  it(
    "journals hooks on the box while disconnected and replays them on reconnect",
    async () => {
      const sid = `e2e-hook-${Date.now()}`;
      const agentSession = `agent-${Date.now()}`;
      await openShell(h, sid, home);

      // Live: the stub agent's hooks go through the real hook script to the
      // remote daemon's listener, and arrive here as `hookEvent`s.
      h.client.writeNoAck(sid, `${REMOTE_AGENT} --session ${agentSession}\n`);
      const live = await pollFor(
        "the stub agent's UserPromptSubmit hook",
        () =>
          hookEvents(h).find(
            (e) => e.payload.paneId === sid && e.payload.eventType === "UserPromptSubmit",
          ),
        STEP_TIMEOUT_MS,
      );
      expect(live.payload.sessionId).toBe(agentSession);

      // Laptop closed: the connection drops and stays down.
      h.hold = true;
      const lostBefore = h.lost;
      const reconnectedBefore = h.reconnected.length;
      killAppSsh();
      await pollFor("the connection loss", () => (h.lost > lostBefore ? true : null), STEP_TIMEOUT_MS);

      // The agent finishes while nobody is connected.
      onRemote(`"$HOME/.manor-e2e/bin/fire-hook" ${sid} Stop ${agentSession}`);
      expect(
        hookEvents(h).some((e) => e.payload.paneId === sid && e.payload.eventType === "Stop"),
      ).toBe(false);

      // Lid open.
      h.hold = false;
      h.client.retryReconnectNow();
      const survivors = await pollFor(
        "the reconnect",
        () => (h.reconnected.length > reconnectedBefore ? h.reconnected[h.reconnected.length - 1] : null),
        2 * STEP_TIMEOUT_MS,
      );
      expect(survivors).toContain(sid);

      const replay = await h.client.replayHooks(live.seq);
      expect(replay).not.toBeNull();
      const stops = replay!.entries.filter(
        (e: HookJournalEntry) => e.payload.paneId === sid && e.payload.eventType === "Stop",
      );
      expect(stops).toHaveLength(1);
      expect(stops[0].payload.sessionId).toBe(agentSession);
      expect(stops[0].seq).toBeGreaterThan(live.seq);
      expect(replay!.lastSeq).toBeGreaterThanOrEqual(stops[0].seq);
    },
    4 * STEP_TIMEOUT_MS,
  );

  it(
    "resyncs from a snapshot after a drop mid-output without duplicating lines",
    async () => {
      const sid = `e2e-resync-${Date.now()}`;
      await openShell(h, sid, home);
      const reconnectedBefore = h.reconnected.length;

      // 300 numbered lines, slowly enough that the drop lands mid-stream. The
      // typed command holds `LINE-$i`, never `LINE-<digits>`, and spells the
      // end marker in two halves, so only the output can match either.
      h.client.writeNoAck(
        sid,
        'i=0; while [ $i -lt 300 ]; do i=$((i+1)); echo "LINE-$i"; sleep 0.02; done; echo "LOOP""-DONE"\n',
      );
      await waitForOutput(h, sid, /LINE-40\r?\n/);
      killAppSsh();
      await pollFor(
        "the reconnect",
        () => (h.reconnected.length > reconnectedBefore ? true : null),
        2 * STEP_TIMEOUT_MS,
      );

      // What the renderer does on reconnect (useTerminalLifecycle +
      // snapshot-dedupe): paint the snapshot, then apply only the events
      // after the position it reflects.
      const snapshot = await h.client.getSnapshot(sid);
      expect(snapshot).not.toBeNull();
      expect(typeof snapshot!.seq).toBe("number");
      const snapshotSeq = snapshot!.seq!;
      const after = () =>
        h.events.filter(
          (e): e is Extract<StreamEvent, { type: "data" }> =>
            e.type === "data" && e.sessionId === sid && typeof e.seq === "number" && e.seq > snapshotSeq,
        );
      await pollFor(
        "LOOP-DONE",
        () =>
          snapshot!.screenAnsi.includes("LOOP-DONE") || after().some((e) => e.data.includes("LOOP-DONE"))
            ? true
            : null,
        2 * STEP_TIMEOUT_MS,
      );

      // No position was delivered twice, across the drop.
      const seqs = h.events
        .filter((e): e is Extract<StreamEvent, { type: "data" }> => e.type === "data" && e.sessionId === sid)
        .map((e) => e.seq)
        .filter((s): s is number => typeof s === "number");
      expect(new Set(seqs).size).toBe(seqs.length);

      const term = new HeadlessTerminal({
        cols: snapshot!.cols,
        rows: snapshot!.rows,
        scrollback: 10_000,
        allowProposedApi: true,
      });
      const write = (data: string) => new Promise<void>((resolve) => term.write(data, resolve));
      await write(snapshot!.screenAnsi);
      for (const e of after().sort((a, b) => a.seq! - b.seq!)) await write(e.data);

      const buffer = term.buffer.active;
      const lines: string[] = [];
      for (let y = 0; y < buffer.length; y++) {
        lines.push(buffer.getLine(y)?.translateToString(true).trim() ?? "");
      }
      const counts = new Map<string, number>();
      for (const line of lines) {
        if (/^LINE-\d+$/.test(line) || line === "LOOP-DONE") {
          counts.set(line, (counts.get(line) ?? 0) + 1);
        }
      }
      const duplicated = [...counts].filter(([, n]) => n > 1).map(([line]) => line);
      expect(duplicated).toEqual([]);
      expect(counts.get("LOOP-DONE")).toBe(1);
      expect(counts.get("LINE-300")).toBe(1);
      term.dispose();
    },
    5 * STEP_TIMEOUT_MS,
  );

  it(
    "reports a session lost when the remote daemon restarts, and serves new ones",
    async () => {
      const sid = `e2e-restart-${Date.now()}`;
      await openShell(h, sid, home);

      onRemote('"$HOME/.manor/bin/manor-host" restart');

      const lost = await pollFor(
        `${sid} reported lost`,
        () =>
          h.events.find(
            (e): e is Extract<StreamEvent, { type: "exit" }> =>
              e.type === "exit" && e.sessionId === sid && e.lost === true,
          ),
        2 * STEP_TIMEOUT_MS,
      );
      expect(lost.lost).toBe(true);
      expect((await h.client.listSessions()).some((s) => s.sessionId === sid)).toBe(false);

      // The replacement daemon came up (spawned by the next remote-bridge).
      const fresh = `${sid}-fresh`;
      await openShell(h, fresh, home);
      await h.client.kill(fresh);
    },
    4 * STEP_TIMEOUT_MS,
  );
});
