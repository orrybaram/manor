import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";

import { bootWorkspaceWithTerminal, expect, test } from "./fixtures";
import { FAKE_AGENT } from "./helpers/fake-agent";
import {
  localApiHeaders,
  newTab,
  waitForVisibleSession,
} from "./helpers/local-api";
import {
  activePaneId,
  awaitShellReady,
  runInTerminal,
} from "./helpers/terminal";

/**
 * Manor's loopback servers answer only Manor's own clients, and pages in a
 * browser pane get a short list of permissions, a prompt for sensitive ones,
 * and nothing else. Driven against the running app: raw HTTP, the `manor` CLI
 * typed into a Manor terminal, the MCP server over stdio, the hook script, a
 * page in a browser pane, and the app window's own clipboard.
 */

const ARTIFACTS = path.join(__dirname, "artifacts", "local-control-api");
const CLI = path.join(__dirname, "..", "..", "dist-electron", "manor-cli.js");
const MCP = path.join(
  __dirname,
  "..",
  "..",
  "dist-electron",
  "mcp-webview-server.js",
);

/** Environment for a process run outside the app: the test home, no MANOR_*. */
function outsideEnv(tempHome: string): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.startsWith("MANOR_")),
    ),
    HOME: tempHome,
  };
}

function controlPort(tempHome: string): number {
  return Number(
    fs.readFileSync(
      path.join(tempHome, ".manor", "webview-server-port"),
      "utf-8",
    ),
  );
}

/** One raw request, headers exactly as given (Node adds Host only if absent). */
function raw(
  port: number,
  method: string,
  reqPath: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path: reqPath, headers },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode!, body: data }));
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/** Talk JSON-RPC to the MCP server over stdio: initialize, then one tool call. */
async function mcpCall(tempHome: string, tool: string): Promise<string> {
  const child = spawn("node", [MCP], {
    env: outsideEnv(tempHome),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  const send = (msg: unknown) => child.stdin.write(`${JSON.stringify(msg)}\n`);
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "e2e", version: "0" },
    },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: tool, arguments: {} },
  });
  try {
    await expect
      .poll(() => out.includes('"id":2'), { timeout: 15_000 })
      .toBe(true);
  } finally {
    child.kill();
  }
  const reply = out.split("\n").find((l) => l.includes('"id":2'))!;
  return reply;
}

/** Replace the native permission dialog: record each message, answer `answer`. */
async function stubPermissionDialog(
  app: ElectronApplication,
  answer: "Allow" | "Block",
) {
  await app.evaluate(({ dialog }, allow) => {
    const g = globalThis as unknown as { __prompts: string[] };
    g.__prompts = [];
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const opts = (
        args.length > 1 ? args[1] : args[0]
      ) as Electron.MessageBoxOptions;
      g.__prompts.push(`${opts.message} [${(opts.buttons ?? []).join("/")}]`);
      return { response: allow ? 1 : 0, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
  }, answer === "Allow");
}

async function prompts(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(
    () => (globalThis as unknown as { __prompts: string[] }).__prompts,
  );
}

/** Run `code` in the browser pane's guest page, as if from a click. */
async function inGuest(
  app: ElectronApplication,
  code: string,
): Promise<string> {
  return app.evaluate(async ({ webContents }, js) => {
    const wc = webContents
      .getAllWebContents()
      .find((w) => w.getType() === "webview" && w.getURL().startsWith("http:"));
    if (!wc) throw new Error("no guest");
    return String(await wc.executeJavaScript(js, true));
  }, code);
}

async function openBrowserPane(window: Page, url: string) {
  await window.keyboard.press("ControlOrMeta+Shift+b");
  await expect(window.locator("webview:visible")).toHaveCount(1, {
    timeout: 10_000,
  });
  await window.keyboard.press("ControlOrMeta+l");
  await window.keyboard.type(url);
  await window.keyboard.press("Enter");
}

test.describe("local control API", () => {
  test.setTimeout(180_000);

  test("answers only Manor's own clients; the CLI, MCP and hooks still work", async ({
    app,
    window,
    tempHome,
    request,
  }) => {
    fs.mkdirSync(ARTIFACTS, { recursive: true });
    const log: string[] = [];
    await bootWorkspaceWithTerminal(app, window, tempHome, "ws-control-api");
    const paneId = await activePaneId(window);
    await awaitShellReady(window, tempHome, paneId);

    // ── Raw requests ──
    const port = controlPort(tempHome);
    const token = localApiHeaders(tempHome)["x-manor-control-token"];
    const host = `127.0.0.1:${port}`;
    const cases: [
      string,
      string,
      string,
      Record<string, string>,
      string | undefined,
      number,
    ][] = [
      ["no token", "GET", "/projects", { Host: host }, undefined, 401],
      [
        "wrong token",
        "GET",
        "/projects",
        { Host: host, "x-manor-control-token": "0".repeat(64) },
        undefined,
        401,
      ],
      [
        "foreign Host",
        "GET",
        "/projects",
        { Host: "example.com", "x-manor-control-token": token },
        undefined,
        403,
      ],
      [
        "Origin present",
        "GET",
        "/projects",
        {
          Host: host,
          Origin: "https://example.com",
          "x-manor-control-token": token,
        },
        undefined,
        403,
      ],
      [
        "text/plain POST",
        "POST",
        "/tabs",
        {
          Host: host,
          "Content-Type": "text/plain",
          "x-manor-control-token": token,
        },
        "{}",
        415,
      ],
      [
        "token + loopback Host",
        "GET",
        "/projects",
        { Host: host, "x-manor-control-token": token },
        undefined,
        200,
      ],
      [
        "token + localhost Host",
        "GET",
        "/projects",
        { Host: `localhost:${port}`, "x-manor-control-token": token },
        undefined,
        200,
      ],
    ];
    log.push(`== control server on ${host}`);
    for (const [name, method, route, headers, body, want] of cases) {
      const res = await raw(port, method, route, headers, body);
      log.push(
        `${name.padEnd(24)} ${method} ${route} → ${res.status} ${res.body.slice(0, 60)}`,
      );
      expect(res.status, name).toBe(want);
    }

    const hookFile = path.join(tempHome, ".manor", "hook-port");
    const [hookPort, hookToken] = fs
      .readFileSync(hookFile, "utf-8")
      .split("\n");
    const hookHost = `127.0.0.1:${hookPort}`;
    const event = `/hook/event?paneId=${paneId}&eventType=Stop&kind=claude`;
    log.push(`== hook server on ${hookHost}`);
    for (const [name, headers, want] of [
      ["no token", { Host: hookHost }, 401],
      [
        "foreign Host",
        { Host: "example.com", "x-manor-hook-token": hookToken! },
        403,
      ],
      [
        "Origin present",
        {
          Host: hookHost,
          Origin: "https://example.com",
          "x-manor-hook-token": hookToken!,
        },
        403,
      ],
    ] as const) {
      const res = await raw(Number(hookPort), "GET", event, { ...headers });
      log.push(`${name.padEnd(24)} GET /hook/event → ${res.status}`);
      expect(res.status, name).toBe(want);
    }

    log.push("== files");
    for (const f of ["webview-server-token", "hook-port"]) {
      const mode = (
        fs.statSync(path.join(tempHome, ".manor", f)).mode & 0o777
      ).toString(8);
      log.push(`~/.manor/${f} mode ${mode}`);
      expect(mode).toBe("600");
    }

    // ── A command the API runs only for a caller with the token ──
    const marker = path.join(tempHome, "ran-with-token");
    const workspacePath = (
      (await (
        await request.get(`http://127.0.0.1:${port}/panes`, {
          headers: localApiHeaders(tempHome),
        })
      ).json()) as { workspacePath: string }
    ).workspacePath;
    const refused = await raw(
      port,
      "POST",
      "/tabs",
      { Host: host, "Content-Type": "text/plain" },
      JSON.stringify({
        workspacePath,
        contentType: "terminal",
        command: `touch "${path.join(tempHome, "ran-without-token")}"`,
      }),
    );
    log.push(`POST /tabs, no token, text/plain → ${refused.status}`);
    expect(refused.status).toBe(401);
    await newTab(request, tempHome, {
      workspacePath,
      contentType: "terminal",
      command: `touch "${marker}"`,
    });
    await expect
      .poll(() => fs.existsSync(marker), { timeout: 30_000 })
      .toBe(true);
    expect(fs.existsSync(path.join(tempHome, "ran-without-token"))).toBe(false);
    log.push(
      "POST /tabs with token ran its command; the refused one never did",
    );

    // ── The manor CLI, typed into a Manor terminal (env pairing) ──
    await window
      .locator(`[data-pane-id="${paneId}"]`)
      .click()
      .catch(() => {});
    const cliOut = path.join(tempHome, "cli-out.txt");
    await runInTerminal(
      window,
      `{ echo "MANOR_WEBVIEW_TOKEN set: \${MANOR_WEBVIEW_TOKEN:+yes}"; manor list-projects; echo "exit=$?"; } > "${cliOut}" 2>&1`,
    );
    await expect
      .poll(
        () =>
          fs.existsSync(cliOut) &&
          fs.readFileSync(cliOut, "utf-8").includes("exit="),
        {
          timeout: 20_000,
        },
      )
      .toBe(true);
    const cli = fs.readFileSync(cliOut, "utf-8");
    log.push(
      "== manor list-projects in a Manor terminal",
      cli.trim().slice(0, 400),
    );
    expect(cli).toContain("MANOR_WEBVIEW_TOKEN set: yes");
    expect(cli).toContain("exit=0");
    expect(cli).toContain("test-project");
    await window.screenshot({
      path: path.join(ARTIFACTS, "1-cli-in-terminal.png"),
    });

    // ── The MCP server, as an agent spawns it ──
    const mcp = await mcpCall(tempHome, "list_projects");
    log.push("== MCP tools/call list_projects", mcp.slice(0, 300));
    expect(mcp).toContain("test-project");
    expect(mcp).not.toContain('"isError":true');

    // ── Agent hooks: the real hook script, then a fake agent's session ──
    await runInTerminal(
      window,
      `echo '{"hook_event_name":"UserPromptSubmit","session_id":"real-hook"}' | "$HOME/.manor/hooks/notify.sh"`,
    );
    await expect
      .poll(
        async () => {
          const res = await request.get(
            `http://127.0.0.1:${port}/agents?offset=0`,
            {
              headers: localApiHeaders(tempHome),
            },
          );
          const agents = (await res.json()) as { paneId: string | null }[];
          return agents.some((a) => a.paneId === paneId);
        },
        { timeout: 20_000 },
      )
      .toBe(true);
    log.push("== notify.sh hook → an agent appeared on the pane");

    await runInTerminal(window, `clear; "${FAKE_AGENT}" control-api-agent`);
    const session = await waitForVisibleSession(request, tempHome, {
      name: "control-api-agent",
    });
    log.push(
      `== fake agent session visible: ${JSON.stringify(session).slice(0, 160)}`,
    );
    await window.waitForTimeout(1000);
    await window.screenshot({
      path: path.join(ARTIFACTS, "2-agent-status.png"),
    });

    fs.writeFileSync(
      path.join(ARTIFACTS, "transcript.txt"),
      `${log.join("\n")}\n`,
    );
  });

  test.describe("with a fake camera", () => {
    // This box has no camera; without one Chromium fails getUserMedia before
    // it ever asks for permission.
    test.use({
      appLaunch: { args: ["--use-fake-device-for-media-stream"] },
    });

    test("browser pane pages get a short list, a prompt, or a refusal; the app window keeps its own", async ({
      app,
      window,
      tempHome,
    }) => {
      fs.mkdirSync(ARTIFACTS, { recursive: true });
      const log: string[] = [];
      const page = http.createServer((_req, res) => {
        res.setHeader("Content-Type", "text/html");
        res.end(`<!doctype html><body style="font:16px sans-serif;padding:16px">
        <h2>Permission probe</h2><pre id="out" style="font-size:15px"></pre>
        <script>window.show = (k, v) => { document.getElementById("out").textContent += k + ": " + v + "\\n"; return v; };</script>
      </body>`);
      });
      await new Promise<void>((resolve) =>
        page.listen(0, "127.0.0.1", resolve),
      );
      const { port: pagePort } = page.address() as AddressInfo;

      try {
        await bootWorkspaceWithTerminal(
          app,
          window,
          tempHome,
          "ws-permissions",
        );
        await openBrowserPane(window, `http://127.0.0.1:${pagePort}/`);
        await expect
          .poll(() => inGuest(app, "document.readyState").catch(() => ""), {
            timeout: 15_000,
          })
          .toBe("complete");

        const probes: Record<string, string> = {
          geolocation: `new Promise(r => navigator.geolocation.getCurrentPosition(() => r("granted"), e => r(e.code === 1 ? "denied" : "allowed (no fix, code " + e.code + ")"), { timeout: 4000 }))`,
          camera: `navigator.mediaDevices.getUserMedia({ video: true }).then(s => { s.getTracks().forEach(t => t.stop()); return "granted"; }, e => e.name === "NotAllowedError" ? "denied" : "allowed (" + e.name + ")")`,
          notifications: `Notification.requestPermission()`,
          midi: `navigator.requestMIDIAccess().then(() => "granted", e => "denied (" + e.name + ")")`,
          "clipboard write": `navigator.clipboard.writeText("from page").then(() => "granted", e => "denied (" + e.name + ")")`,
        };
        const run = async (label: string) => {
          const results: Record<string, string> = {};
          for (const [name, js] of Object.entries(probes)) {
            results[name] = await inGuest(
              app,
              `(async () => show(${JSON.stringify(`${label} · ${name}`)}, await ${js}))()`,
            );
          }
          return results;
        };

        // Block everything the page asks about.
        await stubPermissionDialog(app, "Block");
        const blocked = await run("Block");
        const blockedPrompts = await prompts(app);
        log.push(
          "== answering Block",
          JSON.stringify(blocked, null, 2),
          "prompts:",
          ...blockedPrompts,
        );
        expect(blocked.geolocation).toBe("denied");
        expect(blocked.camera).toBe("denied");
        expect(blocked.notifications).toBe("denied");
        expect(blocked.midi).toMatch(/^denied/);
        expect(blocked["clipboard write"]).toBe("granted");
        expect(blockedPrompts).toEqual([
          "127.0.0.1:" +
            pagePort +
            " wants to know your location [Block/Allow]",
          "127.0.0.1:" + pagePort + " wants to use your camera [Block/Allow]",
          "127.0.0.1:" +
            pagePort +
            " wants to show notifications [Block/Allow]",
        ]);

        // The answer holds: asking again shows no dialog.
        await stubPermissionDialog(app, "Allow");
        const again = await run("Again");
        expect(await prompts(app)).toEqual([]);
        expect(again.geolocation).toBe("denied");
        log.push("== asked again: no prompts, still denied");
        await window.screenshot({
          path: path.join(ARTIFACTS, "3-browser-pane-blocked.png"),
        });

        // A new site gets asked afresh; Allow lets the request through.
        await window.keyboard.press("ControlOrMeta+l");
        await window.keyboard.type(`http://localhost:${pagePort}/`);
        await window.keyboard.press("Enter");
        await expect
          .poll(
            () =>
              inGuest(app, "location.host + document.readyState").catch(
                () => "",
              ),
            { timeout: 15_000 },
          )
          .toBe(`localhost:${pagePort}complete`);
        const allowed = await run("Allow");
        log.push(
          "== new origin, answering Allow",
          JSON.stringify(allowed, null, 2),
          "prompts:",
          ...(await prompts(app)),
        );
        expect(allowed.geolocation).not.toBe("denied");
        expect(allowed.camera).not.toBe("denied");
        expect(allowed.notifications).toBe("granted");
        expect(allowed.midi).toMatch(/^denied/);
        await window.screenshot({
          path: path.join(ARTIFACTS, "4-browser-pane-allowed.png"),
        });

        // The page can't drive the control server even when it knows the port.
        const control = controlPort(tempHome);
        const marker = path.join(tempHome, "ran-from-page");
        const pageFetch = await inGuest(
          app,
          `fetch("http://127.0.0.1:${control}/tabs", { method: "POST", mode: "no-cors", body: JSON.stringify({ command: "touch ${marker}" }) }).then(() => "sent (opaque)", e => "failed: " + e.message)`,
        );
        await window.waitForTimeout(3000);
        log.push(
          `== page POSTs the control server: ${pageFetch}; command ran: ${fs.existsSync(marker)}`,
        );
        expect(fs.existsSync(marker)).toBe(false);

        // The webview recorder captures the pane through the app window's
        // own media permission, driven from the CLI.
        const cli = (args: string[]) =>
          execFileSync("node", [CLI, ...args], {
            env: outsideEnv(tempHome),
            encoding: "utf-8",
          });
        log.push("== manor start-recording", cli(["start-recording"]).trim());
        await window.waitForTimeout(2500);
        const stopped = cli(["stop-recording"]).trim();
        log.push("== manor stop-recording", stopped);
        const bytes = Number(/size: (\d+) bytes/.exec(stopped)?.[1] ?? 0);
        expect(bytes).toBeGreaterThan(0);

        // The app window itself keeps clipboard and notifications without a prompt.
        await stubPermissionDialog(app, "Block");
        await window
          .locator('[data-testid="terminal-pane"]')
          .first()
          .click()
          .catch(() => {});
        const appSide = await window.evaluate(async () => {
          await navigator.clipboard.writeText("copied in Manor");
          const read = await navigator.clipboard.readText();
          return { clipboard: read, notifications: Notification.permission };
        });
        log.push(
          `== app window: ${JSON.stringify(appSide)}; prompts: ${JSON.stringify(await prompts(app))}`,
        );
        expect(appSide).toEqual({
          clipboard: "copied in Manor",
          notifications: "granted",
        });
        expect(await prompts(app)).toEqual([]);

        fs.writeFileSync(
          path.join(ARTIFACTS, "permissions.txt"),
          `${log.join("\n")}\n`,
        );
      } finally {
        page.close();
      }
    });
  });
});
