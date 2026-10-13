import { expect, test } from "./fixtures";
import { openWebApp } from "./helpers/phone";
import { relayTest } from "./helpers/relay-fixture";
import {
  APP_TARGET,
  REMOTE_AGENT,
  hostServerPid,
  installRemoteStubs,
  killAppSsh,
  onRemote,
  pointHostServerAtRelay,
  pollFor,
  remoteKind,
  remoteSkipReason,
  resetRemoteBox,
  seedRemoteRepo,
  setAppTargetReachable,
} from "./helpers/remote-host";
import {
  CONNECT_TIMEOUT,
  STEP,
  agentOnPane,
  hostStatus,
  openRemoteProject,
  retryHost,
} from "./helpers/remote-project";
import { closeSettings, pairHostPhone } from "./helpers/settings";
import { runInTerminal } from "./helpers/terminal";
import { stripAnsi } from "./helpers/ansi";

/**
 * The laptop is gone, and a phone still sees and steers an agent on a remote
 * host (ADR-225): the host's own Manor server, not the desktop's, answers it.
 *
 * 1. The desktop clones a project onto the box and starts the stub agent in a
 *    pane there.
 * 2. A browser is paired with the box's host server from the host's section of
 *    Settings → Remote control (D3, D4) — through a local relay the host
 *    server dials, exactly as it would dial relay.manor.sh.
 * 3. The desktop loses the box: its alias becomes unreachable and its SSH
 *    connections are killed (what a closed lid does to them).
 * 4. The browser opens the pairing link and:
 *    - finds the agent listed, thinking (the host server's own reading of the
 *      daemon's hook journal);
 *    - sees a hook fired on the box after the disconnect move it to
 *      "responded" — live, with no desktop anywhere;
 *    - types into the agent's terminal, and the agent on the box echoes it.
 * 5. The desktop reconnects and replays the same journal: its agent state
 *    matches the host server's (D2, two readers of one journal).
 *
 * The host server owns its host's projects and layout now (ADR-227 D2), and
 * until the desktop hands over what it holds for the host (adoption, ADR-227
 * D3) it has none: it is `pending`. So the phone reaches the agent and its
 * terminal through the bridge, not through a sidebar and a layout. ADR-227
 * ticket 14 rewrites this spec around adoption, a phone-created workspace
 * and a phone-launched agent.
 *
 * Needs the private-sshd target (`node scripts/test-remote-e2e.mjs`): the box
 * must reach the test's local relay on 127.0.0.1, which a Docker container
 * cannot.
 */

const skipReason =
  remoteSkipReason() ??
  (remoteKind() === "docker"
    ? "the container cannot reach the local relay on the test machine's loopback"
    : null);
test.skip(skipReason !== null, skipReason ?? "");

test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  // A clean slate, as remote-host.spec.ts makes one — including the host
  // server's state, so it starts afresh (and against this test's relay) on
  // the desktop's first connect.
  resetRemoteBox();
  installRemoteStubs();
  seedRemoteRepo();
});

test.afterEach(() => {
  setAppTargetReachable(true);
});

/** The fields both readers of the journal must agree on. */
interface AgentState {
  paneId: string | null;
  status: string;
  lastAgentStatus: string | null;
  projectName: string | null;
  agentKind: string;
}

function agentState(a: AgentState): AgentState {
  return {
    paneId: a.paneId,
    status: a.status,
    lastAgentStatus: a.lastAgentStatus,
    projectName: a.projectName,
    agentKind: a.agentKind,
  };
}

relayTest.describe("host server", () => {
  relayTest.setTimeout(CONNECT_TIMEOUT + 8 * STEP);

  relayTest(
    "laptop gone: a phone paired with the host server sees status change live and types into the agent",
    async ({ window, request, tempHome, relay }) => {
      // The host server starts on the desktop's first connect, with the
      // environment the box's sshd gives `remote-bridge`.
      pointHostServerAtRelay(relay.url);

      // 1. A project on the box, and the stub agent thinking in a pane there.
      const { hostId, paneId } = await openRemoteProject(window, request, tempHome);
      const agentSession = `away-${Date.now()}`;
      await runInTerminal(window, `${REMOTE_AGENT} --session ${agentSession}`);
      await pollFor(
        "the remote agent thinking on the desktop",
        async () => {
          const a = await agentOnPane(request, tempHome, paneId);
          return a?.lastAgentStatus === "thinking" ? a : null;
        },
        STEP,
      );

      const serverPid = await pollFor(
        "a host server running on the box",
        () => hostServerPid(),
        STEP,
        500,
      );

      // 2. Pair a phone with the host server, from the desktop.
      const device = await pairHostPhone(window, {
        hostName: APP_TARGET,
        label: "lid-closed phone",
      });
      await closeSettings(window);
      // Minted on the box, so the link names the host server's own room —
      // not the desktop's, which is not even on.
      expect(device.link.startsWith(`${relay.url}/app/`)).toBe(true);

      // 3. Lid closed.
      setAppTargetReachable(false);
      killAppSsh();
      await pollFor(
        "the host to drop",
        async () => ((await hostStatus(window, hostId))?.status === "reconnecting" ? true : null),
        STEP,
      );
      // The server is its own process: losing the desktop leaves it running.
      expect(hostServerPid()).toBe(serverPid);

      // 4. The phone, with only the link.
      const client = await openWebApp(device.link);
      try {
        const page = client.page;

        // The pairing carries the host's name from the host server's hello:
        // the box's own (ADR-225 D7).
        const boxName = onRemote("hostname").stdout.trim();
        await expect
          .poll(
            () =>
              page.evaluate(() => {
                const raw = localStorage.getItem("manor.web.pairings");
                const list = raw ? (JSON.parse(raw) as { name: string }[]) : [];
                return list.map((p) => p.name);
              }),
            { timeout: 15_000 },
          )
          .toEqual([boxName]);

        // Not adopted yet (ADR-227 D3): the host server lists no projects.
        expect(
          await page.evaluate(() => window.electronAPI.projects.getAll()),
        ).toEqual([]);

        // The agent is listed, thinking.
        const phoneAgent = () =>
          page.evaluate(async (pane) => {
            const agents = await window.electronAPI.agents.getActive();
            return agents.find((a: { paneId: string | null }) => a.paneId === pane) ?? null;
          }, paneId);
        await pollFor(
          "the agent on the phone",
          async () => {
            const a = await phoneAgent();
            return a?.lastAgentStatus === "thinking" ? a : null;
          },
          STEP,
        );

        // A hook on the box, nobody's desktop connected: the status moves.
        onRemote(`"$HOME/.manor-e2e/bin/fire-hook" ${paneId} Stop ${agentSession}`);
        await pollFor(
          "the agent responded on the phone",
          async () => ((await phoneAgent())?.lastAgentStatus === "responded" ? true : null),
          STEP,
        );

        // Typing reaches the agent's PTY on the box: the agent itself echoes
        // the line back, which a local echo never would.
        const attached = await page.evaluate(async (pane) => {
          const w = window as unknown as { __paneOutput: string[] };
          w.__paneOutput = [];
          window.electronAPI.pty.onOutput(pane, (data: string) => {
            w.__paneOutput.push(data);
          });
          return window.electronAPI.pty.create(pane, null, 80, 24);
        }, paneId);
        expect(attached).toMatchObject({ ok: true });
        const message = "typed with the lid closed";
        await page.evaluate(
          ([pane, text]) => window.electronAPI.pty.write(pane, `${text}\r`),
          [paneId, message] as const,
        );
        await expect
          .poll(
            async () =>
              stripAnsi(
                await page.evaluate(() =>
                  (window as unknown as { __paneOutput: string[] }).__paneOutput.join(""),
                ),
              ),
            { timeout: 20_000 },
          )
          .toContain(`received: ${message}`);

        // 5. Lid open: the desktop replays the same journal and lands where
        // the host server already is.
        setAppTargetReachable(true);
        await retryHost(window, hostId);
        await pollFor(
          "the host back",
          async () => ((await hostStatus(window, hostId))?.status === "connected" ? true : null),
          2 * STEP,
        );
        const desktop = await pollFor(
          "the desktop's replayed status",
          async () => {
            const a = await agentOnPane(request, tempHome, paneId);
            return a?.lastAgentStatus === "responded" ? a : null;
          },
          STEP,
        );
        const server = await phoneAgent();
        expect(server).not.toBeNull();
        // The project is the desktop's word until adoption: the host server
        // holds no project for this pane yet.
        expect({ ...agentState(server!), projectName: null }).toEqual({
          ...agentState(desktop),
          projectName: null,
        });
        // Still the one server: the desktop reconnecting did not replace it.
        expect(hostServerPid()).toBe(serverPid);
      } catch (err) {
        console.log(`[host-server.spec] phone log:\n${client.log.join("\n")}`);
        throw err;
      } finally {
        await client.close();
      }
    },
  );
});
