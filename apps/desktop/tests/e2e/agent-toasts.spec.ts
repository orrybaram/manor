import path from "node:path";
import type { Page, TestInfo } from "@playwright/test";
import {
  assertVisiblePaneCount,
  bootWorkspaceWithTerminal,
  expect,
  test,
} from "./fixtures";
import { FAKE_AGENT, FAKE_AGENT_ASK, FAKE_AGENT_HUSH } from "./helpers/fake-agent";
import {
  sendToSession,
  tabIdForPane,
  waitForAgentStatus,
  waitForVisibleSession,
} from "./helpers/local-api";
import {
  focusWindow,
  serveRendererFromSource,
} from "./helpers/renderer-dev-server";
import {
  activePaneId,
  awaitShellReady,
  runInTerminal,
} from "./helpers/terminal";

/**
 * Agent attention toasts are about their agent (issue #428): one whose pane is
 * on screen never toasts, and one that toasted goes away as soon as its pane
 * comes on screen — however the user got there, not only by clicking it.
 *
 * Real agents in real panes: the fake agent reports its status over the hook
 * endpoint, and main's unseen flags reach the renderer the way they always
 * do. The renderer is served from source only so the spec can watch the
 * toast module and focus signal it runs.
 */

serveRendererFromSource();

const AGENT_TITLE = "toast-agent";

/** Where evidence screenshots land: `MANOR_E2E_SHOTS`, or the test's output dir. */
function shot(testInfo: TestInfo, name: string): string {
  return path.join(
    process.env.MANOR_E2E_SHOTS ?? testInfo.outputPath(),
    `${name}.png`,
  );
}

/**
 * Record, in the page, every attention toast the agent store asks for and
 * every unseen flag main sends for `agentId` — so "no toast" can be told
 * apart from "nothing tried to toast".
 */
async function watchAttention(window: Page, agentId: string): Promise<void> {
  await window.evaluate(async (id) => {
    const { toast } = (await import(
      /* @vite-ignore */ "/src/toast/index.ts"
    )) as typeof import("../../src/toast");
    const { useAgentStore } = (await import(
      /* @vite-ignore */ "/src/store/agent-store.ts"
    )) as typeof import("../../src/store/agent-store");
    const log = { raised: [] as string[], unseenResponded: false };
    (window as unknown as { __attention: typeof log }).__attention = log;
    for (const kind of ["success", "progress"] as const) {
      const original = toast[kind];
      toast[kind] = ((message: string, opts?: { id?: string }) => {
        if (opts?.id?.startsWith("agent-")) log.raised.push(`${opts.id}: ${message}`);
        return original(message, opts);
      }) as typeof original;
    }
    useAgentStore.subscribe((state) => {
      if (state.unseenRespondedAgentIds.has(id)) log.unseenResponded = true;
    });
  }, agentId);
}

function attentionLog(
  window: Page,
): Promise<{ raised: string[]; unseenResponded: boolean }> {
  return window.evaluate(
    () =>
      (window as unknown as {
        __attention: { raised: string[]; unseenResponded: boolean };
      }).__attention,
  );
}

test("agent toasts never show for an agent on screen, and retract once its pane is", async ({
  app,
  window,
  tempHome,
  request,
}, testInfo) => {
  test.setTimeout(240_000);
  const toasts = window.getByTestId("toast");

  await bootWorkspaceWithTerminal(app, window, tempHome, "agent-toasts");
  const agentPaneId = await activePaneId(window);
  await awaitShellReady(window, tempHome, agentPaneId);
  await runInTerminal(window, `"${FAKE_AGENT}" ${AGENT_TITLE}`);
  const session = await waitForVisibleSession(request, tempHome, {
    name: AGENT_TITLE,
  });
  const agentTabId = await tabIdForPane(request, tempHome, agentPaneId);
  const agentPane = window.locator(
    `[data-testid="workspace-pane"][data-pane-id="${agentPaneId}"]`,
  );

  await focusWindow(app, window);
  await watchAttention(window, session.id);

  await test.step("an agent on screen responds: no toast", async () => {
    await sendToSession(request, tempHome, session.id, FAKE_AGENT_HUSH);
    await waitForAgentStatus(request, tempHome, session.id, "responded");
    // Main flagged the response unseen and the store asked for its toast;
    // the toast held back because its agent is on screen.
    await expect
      .poll(async () => (await attentionLog(window)).unseenResponded, {
        timeout: 30_000,
      })
      .toBe(true);
    await expect
      .poll(async () => (await attentionLog(window)).raised)
      .toContain(`agent-responded-${session.id}: Agent responded`);
    await window.waitForTimeout(1_500);
    await expect(toasts).toHaveCount(0);
    await expect(agentPane).toBeVisible();
    await window.screenshot({ path: shot(testInfo, "agent-onscreen-no-toast") });
  });

  await test.step("an agent off screen needs input: toast", async () => {
    await window.keyboard.press("ControlOrMeta+t");
    await expect(agentPane).toBeHidden({ timeout: 30_000 });
    await assertVisiblePaneCount(window, 1);

    await sendToSession(request, tempHome, session.id, FAKE_AGENT_ASK);
    await waitForAgentStatus(request, tempHome, session.id, "requires_input");
    const needsInput = toasts.filter({ hasText: "Agent needs input" });
    await expect(needsInput).toHaveCount(1, { timeout: 30_000 });
    await expect(needsInput).toContainText(AGENT_TITLE);
    await window.waitForTimeout(400);
    await window.screenshot({ path: shot(testInfo, "agent-needs-input-toast") });
  });

  await test.step("switching to the agent's tab retracts it", async () => {
    await window
      .locator(`[data-testid="tab"][data-tab-id="${agentTabId}"]`)
      .click();
    await expect(agentPane).toBeVisible();
    await expect(toasts.filter({ hasText: "Agent needs input" })).toHaveCount(
      0,
      { timeout: 10_000 },
    );
    await expect(toasts).toHaveCount(0);
    await window.waitForTimeout(400);
    await window.screenshot({
      path: shot(testInfo, "agent-needs-input-retracted"),
    });
  });
});
