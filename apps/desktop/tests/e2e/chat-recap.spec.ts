import fs from "fs";
import path from "path";

import { createWorkspace, expect, importSeededProject, openTerminalTab, test } from "./fixtures";
import { FAKE_AGENT_TRANSCRIPT } from "./helpers/fake-agent";
import { waitForVisibleSession } from "./helpers/local-api";
import { activePaneId, awaitShellReady, runInTerminal } from "./helpers/terminal";

/**
 * Claude Code writes a recap (`away_summary`) while the user is away. The
 * chat shows it where the terminal does, without the "/config" hint.
 */

const RECAP = "You asked for Go to File, and it's done: PR #487 is open. Next, review and merge it.";

test.describe("chat recap", () => {
  test.setTimeout(180_000);

  test("a recap written while the user was away shows after the turn", async ({
    app,
    window,
    tempHome,
    request,
  }) => {
    const chatDir = path.join(tempHome, "fake-chat");
    const transcriptFile = path.join(chatDir, "transcript.jsonl");

    await importSeededProject(app, window, tempHome);
    await createWorkspace(window, "chat-recap");
    await openTerminalTab(window);
    const paneId = await activePaneId(window);
    await awaitShellReady(window, tempHome, paneId);
    await runInTerminal(
      window,
      `"${FAKE_AGENT_TRANSCRIPT}" "${transcriptFile}" "${path.join(chatDir, "input.log")}" e2e-chat-recap`,
    );
    await waitForVisibleSession(request, tempHome, { name: "e2e-chat-recap" });

    const pane = window.locator(`[data-testid="workspace-pane"][data-pane-id="${paneId}"]`);
    await pane.getByTestId("pane-chat-toggle").click({ timeout: 20_000 });
    const chat = pane.getByTestId("chat-pane");
    await expect(chat).toBeVisible();

    const ts = new Date().toISOString();
    fs.appendFileSync(
      transcriptFile,
      [
        {
          type: "assistant",
          uuid: "recap-a1",
          timestamp: ts,
          message: { id: "msg_recap", role: "assistant", content: [{ type: "text", text: "PR is up." }] },
        },
        { type: "system", subtype: "turn_duration", uuid: "recap-t1", timestamp: ts, durationMs: 42_000 },
        {
          type: "system",
          subtype: "away_summary",
          uuid: "recap-r1",
          timestamp: ts,
          content: `${RECAP} (disable recaps in /config)`,
        },
      ]
        .map((l) => `${JSON.stringify(l)}\n`)
        .join(""),
    );

    const recap = chat.getByTestId("chat-recap");
    await expect(recap).toContainText(RECAP, { timeout: 20_000 });
    await expect(recap).not.toContainText("/config");
    const turnBox = await chat.getByTestId("chat-turn-end").boundingBox();
    const recapBox = await recap.boundingBox();
    expect(turnBox!.y).toBeLessThan(recapBox!.y);

    await window.screenshot({
      path: path.join(process.env.CHAT_RECAP_SHOT_DIR ?? "test-results", "chat-recap.png"),
    });
  });
});
