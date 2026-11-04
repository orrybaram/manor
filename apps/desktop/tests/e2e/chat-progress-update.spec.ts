import fs from "fs";
import path from "path";

import { createWorkspace, expect, importSeededProject, openTerminalTab, test } from "./fixtures";
import { FAKE_AGENT_TRANSCRIPT } from "./helpers/fake-agent";
import { waitForVisibleSession } from "./helpers/local-api";
import { activePaneId, awaitShellReady, runInTerminal } from "./helpers/terminal";

/**
 * Claude Code can write a reply as a thinking block marked
 * `thinkingDisplay: "updates"`. The chat shows it, in order, where the terminal
 * does; thinking not marked that way stays out.
 */

const UPDATE = "Yes, it works: the API returns the full article.";
const PRIVATE = "Reasoning the chat must not show.";

function assistantLine(uuid: string, block: unknown, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    type: "assistant",
    uuid,
    timestamp: new Date().toISOString(),
    ...extra,
    message: { id: "msg_update", role: "assistant", content: [block] },
  })}\n`;
}

test.describe("chat progress updates", () => {
  test.setTimeout(180_000);

  test("an update written before a question shows between its thought and the card", async ({
    app,
    window,
    tempHome,
    request,
  }) => {
    const chatDir = path.join(tempHome, "fake-chat");
    const transcriptFile = path.join(chatDir, "transcript.jsonl");

    await importSeededProject(app, window, tempHome);
    await createWorkspace(window, "chat-update");
    await openTerminalTab(window);
    const paneId = await activePaneId(window);
    await awaitShellReady(window, tempHome, paneId);
    await runInTerminal(
      window,
      `"${FAKE_AGENT_TRANSCRIPT}" "${transcriptFile}" "${path.join(chatDir, "input.log")}" e2e-chat-update`,
    );
    await waitForVisibleSession(request, tempHome, { name: "e2e-chat-update" });

    const pane = window.locator(`[data-testid="workspace-pane"][data-pane-id="${paneId}"]`);
    await pane.getByTestId("pane-chat-toggle").click({ timeout: 20_000 });
    const chat = pane.getByTestId("chat-pane");
    await expect(chat).toBeVisible();

    fs.appendFileSync(
      transcriptFile,
      assistantLine(
        "update-1",
        { type: "thinking", thinking: PRIVATE, signature: "x" },
        { thinkingDurationMs: 6000 },
      ) +
        assistantLine(
          "update-2",
          { type: "thinking", thinking: UPDATE, signature: "x" },
          { thinkingDurationMs: 1, thinkingDisplay: "updates" },
        ) +
        assistantLine("update-3", {
          type: "tool_use",
          id: "toolu_update",
          name: "AskUserQuestion",
          input: {
            questions: [
              {
                question: "Which way should the article show?",
                header: "Article view",
                multiSelect: false,
                options: [
                  { label: "Popover", description: "Swaps to the article" },
                  { label: "Modal", description: "A centered modal" },
                ],
              },
            ],
          },
        }),
    );

    const reply = chat.getByTestId("chat-assistant").filter({ hasText: UPDATE });
    await expect(reply).toBeVisible({ timeout: 20_000 });
    const question = chat.getByText("Which way should the article show?");
    await expect(question).toBeVisible();
    await expect(chat).not.toContainText(PRIVATE);

    const replyBox = await reply.boundingBox();
    const questionBox = await question.boundingBox();
    expect(replyBox!.y).toBeLessThan(questionBox!.y);

    await window.screenshot({
      path: path.join(process.env.CHAT_UPDATE_SHOT_DIR ?? "test-results", "chat-progress-update.png"),
    });
  });
});
