import fs from "fs";

import { expect, test } from "./fixtures";
import {
  FAKE_AGENT_TRANSCRIPT,
  FAKE_CHAT_OPTIONS,
  FAKE_CHAT_PROMPT,
  FAKE_CHAT_QUESTION,
  FAKE_CHAT_REPLY,
} from "./helpers/fake-agent";
import {
  openFileFromPalette,
  openFromTree,
  pane,
  revealInTree,
  treeRow,
  typeAtEnd,
} from "./helpers/file-pane";
import { readSession } from "./helpers/local-api";
import { agentNotifications } from "./helpers/notifications";
import { openWebApp } from "./helpers/phone";
import { relayTest } from "./helpers/relay-fixture";
import {
  REMOTE_AGENT,
  installRemoteStubs,
  killAppSsh,
  onRemote,
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
import { closeSettings, pairBrowser } from "./helpers/settings";
import { activePaneId, runInTerminal } from "./helpers/terminal";

/**
 * Remote projects end to end, against a real sshd: a project cloned onto a
 * box, a pane on it, and what the app does when the connection goes away and
 * comes back.
 *
 * - laptop closed: an agent finishes while the app cannot reach the box; the
 *   box journals the hooks, and on reconnect the sidebar shows the final
 *   status with exactly one notification.
 * - remote restart: the box's daemon restarts under a pane running an agent;
 *   the pane comes back with a fresh shell and the agent's resume command.
 * - ports: a dev server in a remote pane shows up in the port list, and
 *   opening it resolves to a local forward that serves it.
 * - file pane: the workspace on the box lists without what its .gitignore
 *   hides, a file opens and saves back to the box, and a write on the box
 *   shows up in the editor.
 *
 * Bootstrap, session lifecycle, journal replay and snapshot resync at the
 * bridge level are in electron/terminal-host/__tests__/remote-ssh.e2e.test.ts.
 *
 * Skipped unless MANOR_E2E_SSH=1. Run through the harness:
 *
 *   node scripts/test-remote-e2e.mjs --playwright-only           # macOS sshd
 *   node scripts/test-remote-e2e.mjs --playwright-only --docker  # Linux box
 */

const skipReason = remoteSkipReason();
test.skip(skipReason !== null, skipReason ?? "");

test.describe.configure({ mode: "serial" });

test.beforeEach(() => {
  // A clean slate on the box before every test, keeping the installed host:
  // stop its daemon and host server, drop its journal, earlier tests' clones
  // and the stubs, then set up again. Each test opens the project through
  // onboarding, which a box still holding the last test's project skips.
  resetRemoteBox();
  installRemoteStubs();
  seedRemoteRepo();
});

test.afterEach(() => {
  // A test that failed while the app's alias was blocked must not leave it so.
  setAppTargetReachable(true);
});

test.describe("remote host", () => {
  test.setTimeout(CONNECT_TIMEOUT + 5 * STEP);

  test("laptop closed: hooks fired while away replay with one notification", async ({
    window,
    request,
    tempHome,
  }) => {
    const { hostId, paneId } = await openRemoteProject(window, request, tempHome);
    const agentSession = `laptop-${Date.now()}`;

    // The stub stays a shell for 1.5 s after its hooks, like a wrapper that
    // doesn't `exec` its agent: that shell in the foreground is not the pane's
    // shell, so the agent must not read as gone.
    await runInTerminal(window, `${REMOTE_AGENT} --linger-ms 1500 --session ${agentSession}`);
    const agent = await pollFor(
      "the remote agent thinking",
      async () => {
        const a = await agentOnPane(request, tempHome, paneId);
        return a?.lastAgentStatus === "thinking" ? a : null;
      },
      STEP,
    );
    await window.waitForTimeout(2_000);
    expect((await agentOnPane(request, tempHome, paneId))?.lastAgentStatus).toBe("thinking");
    const before = agentNotifications(tempHome, agent.id).length;

    // Lid closed: the box becomes unreachable and the live connection dies.
    setAppTargetReachable(false);
    killAppSsh();
    await pollFor(
      "the host to drop",
      async () => ((await hostStatus(window, hostId))?.status === "reconnecting" ? true : null),
      STEP,
    );
    // A routine drop: a pill over the pane, which keeps its last screen.
    await expect(window.getByTestId("host-reconnecting-pill")).toBeVisible({ timeout: STEP });
    await expect(window.getByTestId("host-offline-banner")).not.toBeVisible();

    // The agent finishes, is prompted again, and finishes again — two
    // "responded" transitions nobody was connected to see.
    for (const event of ["Stop", "UserPromptSubmit", "Stop"]) {
      onRemote(`"$HOME/.manor-e2e/bin/fire-hook" ${paneId} ${event} ${agentSession}`);
    }
    expect((await agentOnPane(request, tempHome, paneId))?.lastAgentStatus).toBe("thinking");

    // Lid open.
    setAppTargetReachable(true);
    await retryHost(window, hostId);
    await pollFor(
      "the host back",
      async () => ((await hostStatus(window, hostId))?.status === "connected" ? true : null),
      2 * STEP,
    );

    await pollFor(
      "the replayed final status",
      async () => {
        const a = await agentOnPane(request, tempHome, paneId);
        return a?.lastAgentStatus === "responded" ? a : null;
      },
      STEP,
    );
    await expect(window.getByTestId("host-reconnecting-pill")).not.toBeVisible({ timeout: STEP });
    await expect(window.getByTestId("host-offline-banner")).not.toBeVisible();

    // Coalesced: one notification for the whole absence, not one per hook.
    await expect
      .poll(() => agentNotifications(tempHome, agent.id).length - before, { timeout: STEP })
      .toBe(1);
    await window.waitForTimeout(2_000); // nothing late behind it
    const added = agentNotifications(tempHome, agent.id).slice(before);
    expect(added.map((n) => n.kind)).toEqual(["agent-responded"]);
  });

  test("remote restart: the pane comes back with the agent's resume command", async ({
    window,
    request,
    tempHome,
  }) => {
    const { paneId } = await openRemoteProject(window, request, tempHome, {
      agentCommand: REMOTE_AGENT,
    });
    const agentSession = `resume-${Date.now()}`;

    await runInTerminal(window, `${REMOTE_AGENT} --session ${agentSession}`);
    await pollFor(
      "the remote agent active",
      async () => {
        const a = await agentOnPane(request, tempHome, paneId);
        return a?.lastAgentStatus === "thinking" ? a : null;
      },
      STEP,
    );

    // The box's daemon restarts (a reboot, or `manor-host restart`): every
    // PTY on it is gone, the session with it.
    onRemote('"$HOME/.manor/bin/manor-host" restart');
    // The notice shows when recovery starts and auto-dismisses; watch for it
    // now rather than after the resume lands (slower on Linux).
    const notice = expect(
      window.getByText(/Remote host restarted — \d+ sessions? resumed/),
    ).toBeVisible({ timeout: 2 * STEP });

    // The pane is recovered on a fresh shell, and Manor types the resume
    // command the connector builds for the agent's session.
    await pollFor(
      "the stub agent resumed on the box",
      () =>
        onRemote('cat "$HOME/.manor-e2e/resumed.log" 2>/dev/null; true')
          .stdout.split("\n")
          .includes(agentSession)
          ? true
          : null,
      2 * STEP,
      500,
    );
    await notice;
    await expect
      .poll(() => readSession(request, tempHome, paneId), { timeout: STEP })
      .toContain(`manor-e2e-agent resumed ${agentSession}`);
  });

  test("ports: a remote dev server is listed and opens through a local forward", async ({
    window,
    request,
    tempHome,
  }) => {
    const { hostId } = await openRemoteProject(window, request, tempHome);
    const remotePort = 41_000 + Math.floor(Math.random() * 8_000);
    const body = `manor-e2e-served-${remotePort}`;

    await runInTerminal(
      window,
      `node -e "require('http').createServer((q,s)=>s.end('${body}')).listen(${remotePort},'127.0.0.1')"`,
    );

    type Port = { port: number; hostId?: string; hostname: string | null };
    const listed = await pollFor(
      `port ${remotePort} on the remote host`,
      async () => {
        const ports = (await window.evaluate(() => window.electronAPI.ports.scanNow())) as Port[];
        return ports.find((p) => p.port === remotePort && p.hostId === hostId);
      },
      STEP,
      1_000,
    );
    if (!listed.hostname) {
      await expect(
        window.getByRole("button", { name: `Open localhost:${remotePort}`, exact: true }),
      ).toBeVisible({ timeout: STEP });
    }

    // Opening it is what a port badge click does: main swaps in a forward.
    const resolved = await window.evaluate(
      ([url, id]) => window.electronAPI.ports.resolveUrl(url, id),
      [`http://localhost:${remotePort}/`, hostId] as const,
    );
    const match = /^http:\/\/(?:localhost|127\.0\.0\.1):(\d+)\/$/.exec(resolved);
    expect(match, `resolved URL ${resolved}`).not.toBeNull();
    if (remoteKind() !== "docker") {
      // On the macOS sshd the box *is* this machine, so the remote port is
      // taken here and the forward must have picked another one.
      expect(Number(match![1])).not.toBe(remotePort);
    }
    const res = await request.get(resolved);
    expect(res.ok()).toBe(true);
    expect(await res.text()).toBe(body);
  });

  test("file pane: lists, opens, saves and follows a file on the box", async ({
    window,
    request,
    tempHome,
  }) => {
    await openRemoteProject(window, request, tempHome);

    // Where the pane's workspace is on the box, as its own shell says.
    onRemote('rm -f "$HOME/.manor-e2e/ws-path"');
    await runInTerminal(window, 'mkdir -p "$HOME/.manor-e2e" && pwd > "$HOME/.manor-e2e/ws-path"');
    const ws = await pollFor(
      "the remote workspace's path",
      () => onRemote('cat "$HOME/.manor-e2e/ws-path" 2>/dev/null; true').stdout.trim() || null,
      STEP,
    );
    const file = `${ws}/src/a.ts`;
    const onBox = () => onRemote(`cat "${file}"`).stdout;

    // A source file, and two folders its .gitignore hides.
    onRemote(
      `cd "${ws}" && mkdir -p src node_modules/left-pad dist && ` +
        "printf 'node_modules/\\ndist/\\n' > .gitignore && " +
        "printf 'export const a = 1;\\n' > src/a.ts && " +
        "printf 'module.exports = 1;\\n' > node_modules/left-pad/index.js && " +
        "printf 'console.log(1);\\n' > dist/out.js",
    );

    await openFileFromPalette(window);
    const drawer = pane(window).locator('[data-testid="file-pane-drawer"]');
    await expect(drawer).toBeVisible();
    await revealInTree(window, ["src", "a.ts"]);
    await expect(treeRow(window, ".gitignore")).toBeVisible();
    await expect(
      drawer.locator('[data-testid="file-pane-tree-row"][data-path^="node_modules"]'),
    ).toHaveCount(0);
    await expect(drawer.locator('[data-testid="file-pane-tree-row"][data-path^="dist"]')).toHaveCount(0);

    await openFromTree(window, ["src", "a.ts"]);
    const editor = pane(window).locator('[data-testid="file-pane-editor"]');
    await expect(editor).toContainText("export const a = 1;", { timeout: STEP });

    // ⌘S writes it back to the box.
    await typeAtEnd(window, "// from the desk");
    await window.keyboard.press("ControlOrMeta+s");
    await expect.poll(onBox, { timeout: STEP }).toContain("// from the desk");

    // A write on the box reaches the open file: the watch runs over the
    // remote backend too.
    onRemote(`printf 'export const a = 2;\\n' > "${file}"`);
    await expect(editor).toContainText("export const a = 2;", { timeout: STEP });
    await expect(editor).not.toContainText("// from the desk");
  });

  // The phone chat for an agent on a remote host. The agent runs on
  // the box and writes its transcript there; main reads it back over the
  // host's Exec, and the answer travels the other way through the pane's PTY.
  // The phone half is the same paired Playwright page `phone-chat.spec.ts` uses.
  relayTest(
    "phone chat: a remote agent's transcript reads as a chat and its picker answers on the box",
    async ({ window, request, tempHome }) => {
      const chatDir = "$HOME/.manor-e2e/chat";
      const remoteAgent = "$HOME/.manor-e2e/bin/fake-agent-transcript.sh";
      const transcriptFile = `${chatDir}/transcript.jsonl`;
      const inputLogFile = `${chatDir}/input.log`;
      const DOWN = "\x1b[B";
      const ENTER = "\r";
      const OPTION_3_KEYS = DOWN + DOWN + ENTER;
      const inputLog = () =>
        onRemote(`cat "${inputLogFile}" 2>/dev/null; true`).stdout.replace(
          /\n/g,
          ENTER,
        );

      // The fake agent lives on the box, where its transcript is written.
      onRemote(`mkdir -p "$HOME/.manor-e2e/bin" "${chatDir}"`);
      onRemote(`cat > "${remoteAgent}" && chmod 755 "${remoteAgent}"`, {
        stdin: fs.readFileSync(FAKE_AGENT_TRANSCRIPT),
      });

      const { paneId } = await openRemoteProject(window, request, tempHome);
      await runInTerminal(
        window,
        `"${remoteAgent}" "${transcriptFile}" "${inputLogFile}" e2e-remote-chat-agent`,
      );
      await pollFor(
        "the remote transcript",
        () =>
          onRemote(
            `test -s "${transcriptFile}" && echo ok; true`,
          ).stdout.includes("ok")
            ? true
            : null,
        STEP,
      );

      const device = await pairBrowser(window, { label: "remote chat phone" });
      await closeSettings(window);
      const client = await openWebApp(device.link, {
        viewport: { width: 390, height: 844 },
        context: { isMobile: true, hasTouch: true },
      });

      try {
        const page = client.page;
        await expect(page.getByTestId("phone-top-bar")).toBeVisible({
          timeout: 30_000,
        });
        await expect
          .poll(() => activePaneId(page), { timeout: 15_000 })
          .toBe(paneId);
        const pane = page.locator(
          `[data-testid="workspace-pane"][data-pane-id="${paneId}"]`,
        );

        // The chat, not the terminal, and the transcript read off the box.
        const chat = pane.getByTestId("chat-pane");
        await expect(chat).toBeVisible({ timeout: STEP });
        await expect(
          chat.getByTestId("chat-user").filter({ hasText: FAKE_CHAT_PROMPT }),
        ).toBeVisible({ timeout: STEP });
        await expect(
          chat
            .getByTestId("chat-assistant")
            .filter({ hasText: FAKE_CHAT_REPLY }),
        ).toBeVisible();
        const card = chat.getByTestId("chat-question");
        await expect(card).toBeVisible();
        await expect(card).toContainText(FAKE_CHAT_QUESTION);
        const options = card.getByTestId("chat-question-option");
        await expect(options).toHaveCount(FAKE_CHAT_OPTIONS.length);

        // Option 3: Down, Down, Enter reach the agent on the box, and the
        // tool_result it writes there collapses the card.
        await options.nth(2).tap();
        await pollFor(
          "Down, Down, Enter in the remote input log",
          () => (inputLog().includes(OPTION_3_KEYS) ? true : null),
          15_000,
        );
        const answered = chat.getByTestId("chat-question-answered");
        await expect(answered).toBeVisible({ timeout: STEP });
        await expect(answered).toContainText(FAKE_CHAT_OPTIONS[2]);
        await expect(chat.getByTestId("chat-question")).toHaveCount(0);
        expect(inputLog().split(OPTION_3_KEYS)).toHaveLength(2);
      } finally {
        await client.close();
      }
    },
  );
});
