import type { ElectronApplication } from "@playwright/test";
import {
  assertVisiblePaneCount,
  bootWorkspaceWithTerminal,
  expect,
  test,
} from "./fixtures";

/**
 * ADR-170: the native application menu.
 *
 * The menu lives in the main process, so the test reads it from there with
 * `app.evaluate` and clicks items the way macOS would — through the
 * `MenuItem.click` of the installed template — then watches the renderer.
 */

interface MenuNode {
  label: string;
  enabled: boolean;
  checked: boolean;
  accelerator: string | null;
  registerAccelerator: boolean;
  submenu: MenuNode[] | null;
}

/** Serialize the installed application menu into plain data. */
function readMenu(app: ElectronApplication): Promise<MenuNode[]> {
  return app.evaluate(({ Menu }) => {
    // Electron's MenuItem is not serializable; walk it by hand.
    const walk = (items: Electron.MenuItem[]): MenuNode[] =>
      items
        .filter((item) => item.type !== "separator")
        .map((item) => ({
          label: item.label,
          enabled: item.enabled,
          checked: item.checked,
          accelerator: item.accelerator ?? null,
          registerAccelerator: item.registerAccelerator,
          submenu: item.submenu ? walk(item.submenu.items) : null,
        }));
    const menu = Menu.getApplicationMenu();
    return menu ? walk(menu.items) : [];
  });
}

/** Click a menu item by its label path, e.g. ["File", "New Tab"]. */
function clickMenuItem(
  app: ElectronApplication,
  labels: string[],
): Promise<void> {
  return app.evaluate(({ Menu, BrowserWindow }, path) => {
    let items = Menu.getApplicationMenu()?.items ?? [];
    let item: Electron.MenuItem | undefined;
    for (const label of path) {
      item = items.find((candidate) => candidate.label === label);
      if (!item) throw new Error(`Menu item not found: ${path.join(" › ")}`);
      items = item.submenu?.items ?? [];
    }
    const win = BrowserWindow.getAllWindows()[0];
    item!.click(undefined, win, undefined);
  }, labels);
}

function find(nodes: MenuNode[], label: string): MenuNode {
  const node = nodes.find((n) => n.label === label);
  if (!node) {
    throw new Error(
      `No menu item "${label}" among: ${nodes.map((n) => n.label).join(", ")}`,
    );
  }
  return node;
}

test.describe("application menu", () => {
  test("has Manor's menus with display-only shortcuts", async ({ app }) => {
    const menu = await readMenu(app);
    // Dev builds carry the branch in the app name ("Manor (my-branch)").
    expect(menu[0].label).toMatch(/^Manor/);
    expect(menu.slice(1).map((m) => m.label)).toEqual([
      "File",
      "Edit",
      "View",
      "Workspace",
      "Pane",
      "Agents",
      "Window",
      "Help",
    ]);

    const settings = find(menu[0].submenu!, "Settings…");
    expect(settings.accelerator).toBe("Cmd+,");
    expect(settings.registerAccelerator).toBe(false);

    const newAgent = find(find(menu, "File").submenu!, "New Agent");
    expect(newAgent.accelerator).toBe("Cmd+N");
    expect(newAgent.registerAccelerator).toBe(false);

    // App zoom is the one place the menu owns the key.
    const zoomIn = find(find(menu, "View").submenu!, "Zoom In");
    expect(zoomIn.registerAccelerator).toBe(true);

    // Dev build: reload lives under View › Developer, not at the top level.
    const view = find(menu, "View").submenu!;
    expect(view.some((n) => n.label === "Reload")).toBe(false);
    expect(find(view, "Developer").submenu).not.toBeNull();
  });

  test("workspace items are disabled on Home and enabled in a workspace", async ({
    app,
    window,
    tempHome,
  }) => {
    const before = await readMenu(app);
    expect(
      find(find(before, "Workspace").submenu!, "Rename Workspace").enabled,
    ).toBe(false);

    await bootWorkspaceWithTerminal(app, window, tempHome, "menu-smoke");

    await expect
      .poll(async () => {
        const menu = await readMenu(app);
        return find(find(menu, "Workspace").submenu!, "Rename Workspace")
          .enabled;
      })
      .toBe(true);

    const menu = await readMenu(app);
    const switcher = find(find(menu, "Workspace").submenu!, "Switch Workspace");
    const project = switcher.submenu![0];
    expect(
      project.submenu!.some((ws) => ws.label === "menu-smoke" && ws.checked),
    ).toBe(true);
    // The seeded project's main workspace is main; the worktree we made is not.
    expect(
      find(find(menu, "Workspace").submenu!, "Delete Worktree…").enabled,
    ).toBe(true);
  });

  test("menu clicks reach the renderer", async ({ app, window, tempHome }) => {
    await bootWorkspaceWithTerminal(app, window, tempHome, "menu-clicks");
    await assertVisiblePaneCount(window, 1);

    // File › New Tab adds a tab.
    const tabs = window.locator('[data-testid="tab"]');
    const tabCount = await tabs.count();
    await clickMenuItem(app, ["File", "New Tab"]);
    await expect(tabs).toHaveCount(tabCount + 1);

    // Pane › Split Vertical adds a pane to the active tab.
    await clickMenuItem(app, ["Pane", "Split Vertical"]);
    await assertVisiblePaneCount(window, 2);

    // Window › Pin Tab flips the label once the context round-trips.
    await clickMenuItem(app, ["Window", "Pin Tab"]);
    await expect
      .poll(async () => {
        const menu = await readMenu(app);
        return find(menu, "Window").submenu!.some(
          (n) => n.label === "Unpin Tab",
        );
      })
      .toBe(true);

    // View › Toggle Sidebar hides the sidebar (Home row goes with it).
    const homeRow = window.locator('[data-testid="home-row"]');
    await expect(homeRow).toBeVisible();
    await clickMenuItem(app, ["View", "Toggle Sidebar"]);
    await expect(homeRow).toBeHidden();
    await clickMenuItem(app, ["View", "Toggle Sidebar"]);
    await expect(homeRow).toBeVisible();

    // Manor › Settings… opens the settings modal.
    const appMenuLabel = (await readMenu(app))[0].label;
    await clickMenuItem(app, [appMenuLabel, "Settings…"]);
    await expect(window.getByRole("dialog")).toBeVisible();
  });

  test("request-bus items reach their owning components", async ({
    app,
    window,
    tempHome,
  }) => {
    await bootWorkspaceWithTerminal(app, window, tempHome, "menu-bus");

    // Edit › Find… opens the focused terminal's search bar.
    await clickMenuItem(app, ["Edit", "Find…"]);
    await expect(window.getByPlaceholder(/search/i).first()).toBeVisible();
    await window.keyboard.press("Escape");

    // Workspace › Rename Workspace starts the sidebar's inline rename.
    await clickMenuItem(app, ["Workspace", "Rename Workspace"]);
    await expect(
      window.locator('[data-testid="workspace-name-input"]'),
    ).toBeVisible();
    await window.keyboard.press("Escape");

    // Workspace › Switch Workspace › <main> moves the radio to main.
    const menu = await readMenu(app);
    const switcher = find(find(menu, "Workspace").submenu!, "Switch Workspace");
    const project = switcher.submenu![0];
    const other = project.submenu!.find((ws) => !ws.checked);
    expect(other).toBeDefined();
    await clickMenuItem(app, [
      "Workspace",
      "Switch Workspace",
      project.label,
      other!.label,
    ]);
    await expect
      .poll(async () => {
        const next = await readMenu(app);
        const sw = find(find(next, "Workspace").submenu!, "Switch Workspace");
        return sw.submenu![0].submenu!.find((ws) => ws.checked)?.label;
      })
      .toBe(other!.label);
  });
});
