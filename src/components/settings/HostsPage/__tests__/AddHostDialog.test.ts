// @vitest-environment jsdom
/**
 * ADR-233 D4: Settings → Hosts' "Add a host…" wizard. Where, then the ssh
 * or start form, then the new host's device access; Closing it opens its row.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  const hosts = {
    // The store's live list; the tests set `hosts` themselves.
    list: () => new Promise(() => {}),
    onStatusChanged: () => () => {},
    onServerChanged: () => () => {},
    onPairingChanged: () => () => {},
    add: vi.fn(),
    listTemplates: vi.fn(),
    serverStatus: vi.fn(),
    setLinkPhones: vi.fn(),
    setSupervised: vi.fn(),
    encryptKeys: vi.fn(),
  };
  const linear = {
    isConnected: vi.fn(() => Promise.resolve(false)),
    onConnectionChanged: () => () => {},
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = { hosts, linear };
  return hosts;
});

import { useHostStore, type HostStatusInfo } from "../../../../store/host-store";
import type { HostServerView } from "../../../../electron.d";
import { SettingsNavContext } from "../../SettingsModal/settings-nav";
import { TooltipProvider } from "../../../ui/Tooltip/Tooltip";
import { AddHostDialog } from "../AddHostDialog";

const box: HostStatusInfo = {
  hostId: "box",
  spec: { kind: "ssh", target: "me@box" },
  label: "me@box",
  status: "connected",
  providerKind: "ssh",
  capabilities: { canStop: false, canDestroy: false, autoSleep: false },
};

const boxView: HostServerView = {
  state: "connected",
  status: null,
  devices: [],
  linkPhones: true,
  linkedDeviceIds: [],
  supervisor: null,
  supervise: true,
};

describe("AddHostDialog", () => {
  let container: HTMLDivElement;
  let root: Root;
  const goTo = vi.fn();
  const onClose = vi.fn();

  const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const click = (el: HTMLElement | null) =>
    act(() => {
      el?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  const type = (el: HTMLElement | null, value: string) =>
    act(() => {
      const input = el as HTMLInputElement;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  const flush = () => act(async () => {});

  async function render() {
    await act(async () => {
      root.render(
        createElement(
          TooltipProvider,
          null,
          createElement(
            SettingsNavContext.Provider,
            { value: goTo },
            createElement(AddHostDialog, { open: true, onClose }),
          ),
        ),
      );
    });
    await flush();
  }

  /** The current step's label, from the indicator. */
  const currentStep = () =>
    q("add-host-steps")?.querySelector('[aria-current="step"]')?.textContent ?? null;

  beforeEach(() => {
    goTo.mockReset();
    onClose.mockReset();
    api.add.mockReset();
    api.serverStatus.mockReset();
    api.encryptKeys.mockReset();
    api.listTemplates.mockResolvedValue([]);
    useHostStore.setState({ hosts: [], servers: {}, busy: false });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("asks where first, and continues only once a path is picked", async () => {
    await render();
    expect(currentStep()).toBe("1Where");
    const next = q("add-host-continue") as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    click(q("hosts-add-ssh"));
    expect(q("hosts-add-ssh")?.getAttribute("aria-checked")).toBe("true");
    expect(next.disabled).toBe(false);
  });

  it("shows the ssh form, and Back returns to Where", async () => {
    await render();
    click(q("hosts-add-ssh"));
    click(q("add-host-continue"));
    expect(q("add-ssh-host-form")).not.toBeNull();
    expect(currentStep()).toBe("2Connect");
    expect(document.body.textContent).toContain("Connect over SSH");

    click(q("add-host-back"));
    expect(q("add-ssh-host-form")).toBeNull();
    expect(q("hosts-add-ssh")).not.toBeNull();
    expect(currentStep()).toBe("1Where");
  });

  it("shows the start form for a host Manor starts", async () => {
    await render();
    click(q("hosts-add-start"));
    click(q("add-host-continue"));
    await flush();
    expect(q("start-host-form")).not.toBeNull();
    expect(q("add-ssh-host-form")).toBeNull();
    expect(document.body.textContent).toContain("Start a new host");
  });

  it("shows the new host's device access, and Done opens its row", async () => {
    api.add.mockImplementation(async () => {
      useHostStore.setState({ hosts: [box] });
      return { hostId: "box", spec: box.spec };
    });
    api.serverStatus.mockResolvedValue(boxView);
    await render();
    click(q("hosts-add-ssh"));
    click(q("add-host-continue"));
    type(q("add-ssh-host-target"), "me@box");
    click(q("add-ssh-host-connect"));
    await flush();
    await flush();

    expect(api.add).toHaveBeenCalledWith("me@box");
    expect(currentStep()).toBe("3Device access");
    expect(q("add-host-ready")?.textContent).toBe("me@box is ready");
    expect(q("host-device-access")).not.toBeNull();
    expect(q("host-link-phones-toggle")?.getAttribute("aria-checked")).toBe("true");
    expect(api.serverStatus).toHaveBeenCalledWith("box");

    click(q("add-host-done"));
    expect(onClose).toHaveBeenCalled();
    expect(goTo).toHaveBeenCalledWith({ type: "hosts" }, "host-box");
  });

  describe("pairing keys (ADR-236 D6)", () => {
    const plaintext = {
      version: "1.2.3",
      relay: { connected: true },
      secretBackend: "plaintext",
      linear: false,
    } as unknown as NonNullable<HostServerView["status"]>;

    async function addBox(view: HostServerView) {
      api.add.mockImplementation(async () => {
        useHostStore.setState({ hosts: [box] });
        return { hostId: "box", spec: box.spec };
      });
      api.serverStatus.mockResolvedValue(view);
      api.encryptKeys.mockResolvedValue(undefined);
      await render();
      click(q("hosts-add-ssh"));
      click(q("add-host-continue"));
      type(q("add-ssh-host-target"), "me@box");
      click(q("add-ssh-host-connect"));
      await flush();
      await flush();
    }

    it("encrypts a new ssh host's plaintext keys without asking, once", async () => {
      await addBox({ ...boxView, status: plaintext });
      expect(api.encryptKeys).toHaveBeenCalledTimes(1);
      expect(api.encryptKeys).toHaveBeenCalledWith("box");
      // The refresh after the fix reads plaintext again (the mock never changes): no second try.
      await flush();
      expect(api.encryptKeys).toHaveBeenCalledTimes(1);
      expect(q("host-pairing-keys")).not.toBeNull();
    });

    it("leaves a container's keys to its environment", async () => {
      await addBox({ ...boxView, status: plaintext, supervisor: { kind: "container" } });
      expect(api.encryptKeys).not.toHaveBeenCalled();
      expect(q("host-encrypt-container")).not.toBeNull();
    });

    it("has nothing to do for a host already encrypted", async () => {
      await addBox({ ...boxView, status: { ...plaintext, secretBackend: "systemd-creds" } });
      expect(api.encryptKeys).not.toHaveBeenCalled();
      expect(q("host-pairing-keys-state")?.textContent).toBe("Encrypted");
    });
  });

  it("opens the new host's row however the dialog closes after adding", async () => {
    api.add.mockImplementation(async () => {
      useHostStore.setState({ hosts: [box] });
      return { hostId: "box", spec: box.spec };
    });
    api.serverStatus.mockResolvedValue(boxView);
    await render();
    click(q("hosts-add-ssh"));
    click(q("add-host-continue"));
    type(q("add-ssh-host-target"), "me@box");
    click(q("add-ssh-host-connect"));
    await flush();
    await flush();

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onClose).toHaveBeenCalled();
    expect(goTo).toHaveBeenCalledWith({ type: "hosts" }, "host-box");
  });

  it("opens no row when the dialog closes before a host was added", async () => {
    await render();
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onClose).toHaveBeenCalled();
    expect(goTo).not.toHaveBeenCalled();
  });
});
