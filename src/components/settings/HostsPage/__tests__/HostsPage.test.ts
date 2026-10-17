// @vitest-environment jsdom
/**
 * ADR-229 D8, ADR-233 D1: Settings → Hosts. A host's row offers only what
 * its provider can do (Stop, Start it again, Wake), says what keeps its Manor
 * running and whether devices reach it, and is destroyed only once its name
 * is typed.
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
    serverStatus: vi.fn(),
    projectsOnHost: vi.fn(),
    remove: vi.fn(),
    stop: vi.fn(),
    wake: vi.fn(),
    setSupervised: vi.fn(),
    encryptKeys: vi.fn(),
    setLinkPhones: vi.fn(),
    setLinearOnHost: vi.fn(),
    resetPairingKeys: vi.fn(),
  };
  const linear = {
    isConnected: vi.fn(() => Promise.resolve(false)),
    onConnectionChanged: () => () => {},
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = { hosts, linear };
  return hosts;
});

import { useHostStore, type HostStatusInfo } from "../../../../store/host-store";
import type { HostServerView, RemoteDeviceInfo } from "../../../../electron.d";
import { useRemoteControlStore } from "../../../../store/remote-control-store";
import { SettingsJumpContext } from "../../SettingsModal/settings-nav";
import { TooltipProvider } from "../../../ui/Tooltip/Tooltip";
import { HostRow } from "../HostRow";
import {
  blockedDevicesLine,
  devicesReachText,
  idleStopText,
  pairingKeysState,
  supervisionHint,
  supervisorStatusText,
} from "../host-settings-text";

function view(over: Partial<HostServerView> = {}): HostServerView {
  return {
    state: "connected",
    status: null,
    devices: [],
    linkPhones: true,
    linkedDeviceIds: [],
    blockedDevices: [],
    supervisor: null,
    supervise: true,
    ...over,
  };
}

function host(over: Partial<HostStatusInfo> = {}): HostStatusInfo {
  return {
    hostId: "pod",
    spec: { kind: "recipe", recipeId: "dev-pod" },
    label: "Dev pod",
    status: "connected",
    providerKind: "recipe",
    capabilities: { canStop: true, canDestroy: true, autoSleep: false },
    ...over,
  };
}

describe("HostRow", () => {
  let container: HTMLDivElement;
  let root: Root;

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

  /** Renders the row and opens it, unless `jump` names the section to open it by. */
  async function render(
    info: HostStatusInfo,
    server: HostServerView = view(),
    opts: { jump?: string; open?: boolean } = {},
  ) {
    api.serverStatus.mockResolvedValue(server);
    useHostStore.setState({ hosts: [info], servers: {} });
    await act(async () => {
      root.render(
        createElement(
          TooltipProvider,
          null,
          createElement(
            SettingsJumpContext.Provider,
            { value: opts.jump ?? null },
            createElement(HostRow, { host: info, name: info.label ?? info.hostId, readOnly: false }),
          ),
        ),
      );
    });
    await flush();
    if (opts.open ?? opts.jump === undefined) click(q("host-row-toggle"));
    await flush();
  }

  beforeEach(() => {
    for (const fn of [api.serverStatus, api.projectsOnHost, api.remove, api.stop, api.wake, api.setSupervised, api.encryptKeys]) {
      fn.mockReset();
    }
    api.projectsOnHost.mockResolvedValue(["App", "Docs"]);
    api.remove.mockResolvedValue(undefined);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  describe("offers only what the provider can do", () => {
    it("Stop for a connected box its provider can stop", async () => {
      await render(host());
      expect(q("host-stop")).not.toBeNull();
      expect(q("host-start-again")).toBeNull();
      expect(q("host-wake")).toBeNull();
      click(q("host-stop"));
      expect(api.stop).toHaveBeenCalledWith("pod");
    });

    it("no Stop for an ssh box", async () => {
      await render(
        host({
          hostId: "box",
          spec: { kind: "ssh", target: "me@box" },
          label: "me@box",
          providerKind: "ssh",
          capabilities: { canStop: false, canDestroy: false, autoSleep: false },
        }),
      );
      expect(q("host-stop")).toBeNull();
      expect(q("host-remove")).not.toBeNull();
    });

    it("Wake, not Stop, for a sleeping box", async () => {
      await render(host({ status: "sleeping" }));
      expect(q("host-stop")).toBeNull();
      click(q("host-wake"));
      expect(api.wake).toHaveBeenCalledWith("pod");
    });

    it("Start it again for a box deleted outside Manor", async () => {
      await render(host({ status: "error", error: "Dev pod no longer exists", missing: true }));
      expect(container.textContent).toContain("Dev pod no longer exists");
      click(q("host-start-again"));
      expect(api.wake).toHaveBeenCalledWith("pod");
    });

    it("notes an idle stop that works only while the desktop is awake", async () => {
      await render(host({ idleStopNote: true, idleStopMinutes: 30 }));
      expect(q("host-idle-stop-note")?.textContent).toBe("Stops after 30 min idle only while This Mac is awake");
    });

  });

  describe("the row", () => {
    it("starts collapsed, and opens from its header", async () => {
      await render(host(), view(), { open: false });
      const toggle = q("host-row-toggle");
      expect(toggle?.getAttribute("aria-expanded")).toBe("false");
      expect(q("host-supervise-toggle")).toBeNull();
      click(toggle);
      await flush();
      expect(toggle?.getAttribute("aria-expanded")).toBe("true");
      expect(q("host-supervise-toggle")).not.toBeNull();
    });

    it("starts open when a link jumps to its section", async () => {
      await render(host(), view(), { jump: "host-pod" });
      expect(q("host-row-toggle")?.getAttribute("aria-expanded")).toBe("true");
      expect(q("host-row-toggle")?.getAttribute("data-settings-section")).toBe("host-pod");
    });

    it.each([
      [{ linkPhones: true, supervise: true }, "Connected · devices reach it anytime"],
      [{ linkPhones: true, supervise: false }, "Connected · devices reach it"],
      [{ linkPhones: false }, "Connected · devices off"],
    ])("says in words whether devices reach the host (%o)", async (over, line) => {
      await render(host(), view(over), { open: false });
      expect(q("host-row-status")?.textContent).toBe(line);
    });

    it("warns of unencrypted pairing keys in the header and the body", async () => {
      const status = {
        version: "1.2.3",
        relay: { connected: true },
        secretBackend: "plaintext",
        linear: false,
      } as unknown as NonNullable<HostServerView["status"]>;
      await render(host(), view({ status }));
      expect(q("host-row-status")?.textContent).toContain("pairing keys unencrypted");
      expect(q("host-pairing-keys-state")?.textContent).toBe("Unencrypted");
      expect(q("host-phone-summary")?.textContent).toBe("Manor 1.2.3 · relay connected");
      expect(q("host-reset-keys")).not.toBeNull();
    });

    it("turns devices' reach off with its switch", async () => {
      api.setLinkPhones.mockResolvedValue(undefined);
      await render(host());
      click(q("host-link-phones-toggle"));
      await flush();
      expect(api.setLinkPhones).toHaveBeenCalledWith("pod", false);
    });
  });

  describe("pairing-key encryption (ADR-236 D6)", () => {
    const ssh = (over: Partial<HostStatusInfo> = {}) =>
      host({ spec: { kind: "ssh", target: "dev@build" }, providerKind: "ssh", label: "build", ...over });
    const keys = (over: Record<string, unknown> = {}) =>
      ({
        version: "1.2.3",
        relay: { connected: true },
        secretBackend: "plaintext",
        linear: false,
        ...over,
      }) as unknown as NonNullable<HostServerView["status"]>;
    const state = () => q("host-pairing-keys-state")?.textContent;
    const hint = () => q("host-pairing-keys-hint")?.textContent;

    it("offers Encrypt on a connected ssh host, and a click encrypts", async () => {
      api.encryptKeys.mockResolvedValue(undefined);
      await render(ssh(), view({ status: keys() }));
      expect(state()).toBe("Unencrypted");
      expect(hint()).toBe(pairingKeysState(keys(), "button", "build").hint);
      expect(hint()).toContain("Devices stay paired");
      click(q("host-encrypt-keys"));
      await flush();
      expect(api.encryptKeys).toHaveBeenCalledWith("pod");
    });

    it("does not encrypt by itself from the row", async () => {
      await render(ssh(), view({ status: keys() }));
      expect(api.encryptKeys).not.toHaveBeenCalled();
    });

    it("shows Encrypting… while the click runs", async () => {
      let finish!: () => void;
      api.encryptKeys.mockReturnValue(
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
      );
      await render(ssh(), view({ status: keys() }));
      click(q("host-encrypt-keys"));
      await flush();
      expect(state()).toBe("Encrypting…");
      expect((q("host-encrypt-keys") as HTMLButtonElement).disabled).toBe(true);
      finish();
      await flush();
      expect(state()).toBe("Unencrypted");
      expect((q("host-encrypt-keys") as HTMLButtonElement).disabled).toBe(false);
    });

    it("names the key file the click would use, behind the disclosure", async () => {
      await render(ssh(), view({ status: keys({ encryptKeyFile: "~/keys/manor.key" }) }));
      expect(q("host-pairing-keys-detail")).toBeNull();
      click(q("host-pairing-keys-more"));
      expect(q("host-pairing-keys-detail")?.textContent).toContain("a key at ~/keys/manor.key on build");
      expect(q("host-pairing-keys-detail")?.textContent).toContain("whole disk");
    });

    it("hides the button for a recipe host, a container, an away host", async () => {
      await render(host(), view({ status: keys() }));
      expect(q("host-encrypt-keys")).toBeNull();
      expect(state()).toBe("Unencrypted");
      expect(q("host-encrypt-recipe")).not.toBeNull();
      act(() => root.unmount());
      root = createRoot(container);

      await render(ssh(), view({ status: keys(), supervisor: { kind: "container" } }));
      expect(q("host-encrypt-keys")).toBeNull();
      expect(q("host-encrypt-container")).not.toBeNull();
      act(() => root.unmount());
      root = createRoot(container);

      await render(ssh({ status: "error" }), view({ status: keys() }));
      expect(q("host-encrypt-keys")).toBeNull();
      expect(state()).toBe("Unencrypted");
      expect(hint()).toBe("Encrypt them from the desktop app while build is connected.");
    });

    it("hides the button on a read-only row", async () => {
      const info = ssh();
      api.serverStatus.mockResolvedValue(view({ status: keys() }));
      useHostStore.setState({ hosts: [info], servers: {} });
      await act(async () => {
        root.render(
          createElement(
            TooltipProvider,
            null,
            createElement(HostRow, { host: info, name: "build", readOnly: true }),
          ),
        );
      });
      await flush();
      click(q("host-row-toggle"));
      await flush();
      expect(q("host-encrypt-keys")).toBeNull();
    });

    it("reads Encrypted with a key kept in home, without a header warning", async () => {
      await render(
        ssh(),
        view({
          status: keys({
            secretBackend: "key-file",
            secretKeyPlace: "home",
            secretKeyFile: "~/.config/manor/secret.key",
          }),
        }),
      );
      expect(state()).toBe("Encrypted");
      expect(hint()).toBe("Sealed with a key at ~/.config/manor/secret.key on build.");
      expect(q("host-key-on-volume")).toBeNull();
      expect(q("host-encrypt-keys")).toBeNull();
      expect(q("host-row-status")?.textContent).not.toContain("stored on its disk");
      expect(q("host-row-status")?.textContent).not.toContain("unencrypted");
    });

    it("reads Encrypted for systemd-creds", async () => {
      await render(ssh(), view({ status: keys({ secretBackend: "systemd-creds" }) }));
      expect(state()).toBe("Encrypted");
      expect(hint()).toBe("Sealed by systemd on build.");
      expect(q("host-pairing-keys-more")).toBeNull();
    });

    it("warns when the key is inside the data dir", async () => {
      await render(
        ssh(),
        view({ status: keys({ secretBackend: "key-file", secretKeyPlace: "data-dir" }) }),
      );
      expect(state()).toBe("Key kept with data");
      expect(q("host-key-on-volume")?.textContent).toBe("Move it out");
      expect(q("host-row-status")?.textContent).toContain("pairing key stored on its disk");
    });

    it("does not warn about a key in the data dir that doesn't seal the keys", async () => {
      await render(
        ssh(),
        view({ status: keys({ secretBackend: "systemd-creds", secretKeyPlace: "data-dir" }) }),
      );
      expect(state()).toBe("Encrypted");
      expect(q("host-key-on-volume")).toBeNull();
      expect(q("host-row-status")?.textContent).not.toContain("stored on its disk");
    });

    it("falls back to secretKeyOnVolume from an older server", async () => {
      await render(
        ssh(),
        view({ status: keys({ secretBackend: "key-file", secretKeyOnVolume: true }) }),
      );
      expect(state()).toBe("Key kept with data");
    });
  });

  describe("supervision", () => {
    it("shows what supervises the host under its switch", async () => {
      await render(host(), view({ supervisor: { kind: "systemd", linger: false } }));
      expect(q("host-supervisor-status")?.textContent).toBe(
        "Starts after you log in to Dev pod. Run `sudo loginctl enable-linger $USER` there to start it at boot.",
      );
      expect(q("host-supervise-toggle")?.getAttribute("aria-checked")).toBe("true");
    });

    it("shows a container's switch on and locked: supervise is its entrypoint", async () => {
      await render(host(), view({ supervise: false, supervisor: { kind: "container" } }));
      const toggle = q("host-supervise-toggle") as HTMLButtonElement;
      expect(toggle.getAttribute("aria-checked")).toBe("true");
      expect(toggle.disabled).toBe(true);
    });

    it("disables the switch while the host is away", async () => {
      await render(host({ status: "reconnecting" }));
      expect((q("host-supervise-toggle") as HTMLButtonElement).disabled).toBe(true);
      expect(q("host-supervisor-status")?.textContent).toBe("Change this while Dev pod is connected.");
    });
  });

  describe("phones removed on the host (ADR-238 D3)", () => {
    it("shows the hint under the switch", async () => {
      await render(host(), view({ blockedDevices: [{ id: "p1", label: "Orry's phone" }] }));
      expect(q("host-blocked-devices")?.textContent).toBe(
        "Orry's phone was removed on Dev pod. Turn the switch off and on to pair it again.",
      );
    });

    it("leaves blocked devices out of the device count", async () => {
      const dev = (id: string) => ({ id }) as RemoteDeviceInfo;
      useRemoteControlStore.setState({
        status: { ...useRemoteControlStore.getState().status, devices: [dev("p1"), dev("p2")] },
      });
      await render(host(), view({ blockedDevices: [{ id: "p1", label: "Orry's phone" }] }));
      expect(q("host-device-access")?.textContent).toContain("Your device reaches Dev pod directly");
    });

    it("shows no hint when nothing was removed", async () => {
      await render(host(), view());
      expect(q("host-blocked-devices")).toBeNull();
    });
  });

  describe("removing", () => {
    it("destroys only once the host's name is typed", async () => {
      await render(host());
      click(q("host-remove"));
      await flush();
      expect(q("host-destroy-projects")?.textContent).toBe("App, Docs");
      const destroy = q("host-destroy-confirm") as HTMLButtonElement;
      expect(destroy.disabled).toBe(true);
      type(q("host-destroy-input"), "Dev po");
      expect(destroy.disabled).toBe(true);
      type(q("host-destroy-input"), "Dev pod");
      expect(destroy.disabled).toBe(false);
      click(destroy);
      await flush();
      expect(api.remove).toHaveBeenCalledWith("pod", { destroy: true });
      expect(q("host-remove-dialog")).toBeNull();
    });

    it("removes from Manor with a plain confirm, and offers no destroy where it can't", async () => {
      await render(host({ capabilities: { canStop: false, canDestroy: false, autoSleep: false } }));
      click(q("host-remove"));
      await flush();
      expect(q("host-destroy-input")).toBeNull();
      expect(api.projectsOnHost).not.toHaveBeenCalled();
      click(q("host-remove-plain"));
      await flush();
      expect(api.remove).toHaveBeenCalledWith("pod", { destroy: false });
    });

    it("keeps the dialog open, saying why, when the destroy fails", async () => {
      api.remove.mockRejectedValue(new Error("destroy.sh exited 1"));
      await render(host());
      click(q("host-remove"));
      await flush();
      type(q("host-destroy-input"), "Dev pod");
      click(q("host-destroy-confirm"));
      await flush();
      expect(q("host-remove-error")?.textContent).toContain("destroy.sh exited 1");
      expect(q("host-remove-dialog")).not.toBeNull();
    });
  });
});

describe("devicesReachText (ADR-238)", () => {
  it("words 0, 1 and 2 devices", () => {
    expect(devicesReachText(0)).toBe("Devices you pair reach");
    expect(devicesReachText(1)).toBe("Your device reaches");
    expect(devicesReachText(2)).toBe("Your 2 devices reach");
  });
});

describe("blockedDevicesLine (ADR-238 D3)", () => {
  it("names one device", () => {
    expect(blockedDevicesLine(["Orry's phone"], "build")).toBe(
      "Orry's phone was removed on build. Turn the switch off and on to pair it again.",
    );
  });

  it("lists several", () => {
    expect(blockedDevicesLine(["a", "b", "c"], "build")).toBe(
      "a, b and c were removed on build. Turn the switch off and on to pair them again.",
    );
    expect(blockedDevicesLine(["a", "b"], "build")).toMatch(/^a and b were removed/);
  });
});

describe("host settings text (ADR-229 D4, D7)", () => {
  const ssh = { kind: "ssh", target: "dev@build" } as const;

  it("says what supervises the host", () => {
    expect(supervisorStatusText({ kind: "systemd", linger: true }, "build", ssh)).toBe("Runs at boot (systemd)");
    expect(supervisorStatusText({ kind: "systemd" }, "build", ssh)).toBe("Runs at boot (systemd)");
    expect(supervisorStatusText({ kind: "systemd", linger: false }, "build", ssh)).toBe(
      "Starts after you log in to build. Run `sudo loginctl enable-linger dev` there to start it at boot.",
    );
    expect(supervisorStatusText({ kind: "launchd" }, "mini", null)).toBe(
      "Starts at login (launchd). A headless Mac needs automatic login.",
    );
    expect(supervisorStatusText({ kind: "container" }, "pod", null)).toBe("Runs from the container's entrypoint");
    expect(supervisorStatusText(null, "pod", null)).toBeNull();
  });

  it("explains the switch when nothing supervises the host", () => {
    expect(supervisionHint(view({ supervise: false }), "build", true)).toMatch(/^Off:/);
    expect(supervisionHint(view({ supervise: true }), "build", true)).toMatch(/next connect/);
    expect(supervisionHint(view({ supervisor: { kind: "container" } }), "build", true)).toBeNull();
    expect(supervisionHint(null, "build", false)).toBe("Change this while build is connected.");
  });

  it("words the Pairing keys row (ADR-236 D6)", () => {
    const plain = { secretBackend: "plaintext" };
    expect(pairingKeysState(plain, "button", "build")).toEqual({
      tone: "caution",
      state: "Unencrypted",
      hint: "Stored as plain files on build. Manor can seal them in one step. Devices stay paired.",
      detail:
        "Manor makes a key at ~/.config/manor/secret.key on build and restarts its server to use it. A copy of ~/.manor can't read the pairing keys then. A copy of build's whole disk, or anyone with your account on it, still can.",
      headerWarning: "pairing keys unencrypted",
    });
    expect(pairingKeysState({ ...plain, encryptKeyFile: "~/k" }, "button", "build").detail).toContain(
      "a key at ~/k on build",
    );
    expect(pairingKeysState(plain, "recipe", "build").hint).toBe("The recipe has to supply a key.");
    expect(pairingKeysState(plain, "container", "build").detail).toBeNull();
    expect(pairingKeysState(plain, "button", "build", true)).toMatchObject({
      tone: "busy",
      state: "Encrypting…",
      hint: "Restarting build's server. Devices reconnect on their own.",
    });
    expect(
      pairingKeysState({ secretBackend: "key-file", secretKeyPlace: "home", secretKeyFile: "~/k" }, "none", "build"),
    ).toMatchObject({ tone: "ok", state: "Encrypted", hint: "Sealed with a key at ~/k on build.", headerWarning: null });
    expect(
      pairingKeysState({ secretBackend: "key-file", secretKeyPlace: "elsewhere", secretKeyFile: null }, "none", "build").hint,
    ).toBe("Sealed with a key from build's environment.");
    expect(pairingKeysState({ secretBackend: "key-file", secretKeyPlace: "data-dir" }, "none", "build")).toMatchObject({
      tone: "partial",
      state: "Key kept with data",
      hint: "The key sits inside ~/.manor on build, beside what it seals.",
      headerWarning: "pairing key stored on its disk",
    });
    expect(pairingKeysState({ secretBackend: "libsecret" }, "none", "build").hint).toBe("Sealed by build's keyring.");
  });

  it("words the idle-stop caveat", () => {
    expect(idleStopText(30, "This Mac")).toBe("Stops after 30 min idle only while This Mac is awake");
  });
});
