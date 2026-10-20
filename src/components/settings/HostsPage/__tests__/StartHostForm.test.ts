// @vitest-environment jsdom
/**
 * A template's Connect step. Its readiness checklist (a row per
 * check, with its state and fix), Start gated on every check passing and
 * every required field being filled, the "Advanced" disclosure, and when the
 * checklist is asked again.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TemplateCheck, TemplateCheckResult, TemplateInfo } from "../../../../electron.d";

const api = vi.hoisted(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  const hosts = {
    listTemplates: vi.fn(),
    checkTemplate: vi.fn(),
    runTemplateFix: vi.fn(),
    createRecipe: vi.fn(),
    addRecipeHost: vi.fn(),
    // The host store, which the profile editor's sign-in section reads.
    // vi.fn, as beforeEach resets every one; the store subscribes once, on import.
    list: vi.fn(() => new Promise(() => {})),
    onStatusChanged: vi.fn(() => () => {}),
    onServerChanged: vi.fn(() => () => {}),
    onPairingChanged: vi.fn(() => () => {}),
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = { hosts };
  return hosts;
});

import { TooltipProvider } from "../../../ui/Tooltip/Tooltip";
import { StartHostForm } from "../StartHostForm";

const docker: TemplateInfo = {
  id: "docker",
  name: "Docker container",
  description: "A container on this computer's Docker.",
  perHost: ["name"],
  fields: [
    {
      key: "where",
      label: "Run it on",
      type: "segmented",
      default: "local",
      options: [
        { value: "local", label: "This computer" },
        { value: "ssh", label: "Another machine over SSH" },
      ],
    },
    {
      key: "sshTarget",
      label: "SSH target",
      required: true,
      showWhen: { key: "where", value: "ssh" },
    },
    { key: "name", label: "Container name", default: "manor-abc123", required: true, advanced: true },
    { key: "image", label: "Image", default: "ghcr.io/orrybaram/manor-host:1.0.0", required: true, advanced: true },
    { key: "context", label: "Docker context", type: "choice", advanced: true },
    {
      key: "agents",
      label: "Agents to install",
      type: "multi",
      default: "claude",
      options: [
        { value: "claude", label: "Claude Code" },
        { value: "codex", label: "Codex" },
      ],
    },
  ],
};

const kubernetes: TemplateInfo = {
  id: "kubernetes",
  name: "Kubernetes cluster",
  description: "Pods on a cluster you have access to.",
  perHost: ["name"],
  fields: [
    { key: "context", label: "Cluster", type: "choice", required: true },
    {
      key: "size",
      label: "Size",
      type: "size",
      default: "medium",
      options: [
        { value: "small", label: "Small", hint: "1 CPU, 2 GiB" },
        { value: "medium", label: "Medium", hint: "2 CPUs, 4 GiB" },
      ],
    },
    { key: "namespace", label: "Namespace", default: "manor", required: true, advanced: true },
    { key: "storageClass", label: "Storage class", advanced: true },
  ],
};

const ok = (id: string): TemplateCheck => ({ id, state: "ok", title: `${id} is fine` });
const result = (checks: TemplateCheck[], extra: Partial<TemplateCheckResult> = {}): TemplateCheckResult => ({
  checks,
  choices: {},
  ...extra,
});

describe("StartHostForm — a template's Connect step", () => {
  let container: HTMLDivElement;
  let root: Root;

  const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const click = (el: HTMLElement | null) =>
    act(() => {
      el?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  const flush = () => act(async () => {});
  const submit = () => q("start-host-submit") as HTMLButtonElement;

  async function open(template: TemplateInfo) {
    api.listTemplates.mockResolvedValue([docker, kubernetes]);
    await act(async () => {
      root.render(
        createElement(TooltipProvider, null, createElement(StartHostForm, { onStarted: vi.fn() })),
      );
    });
    await flush();
    click(q("start-host-template"));
    const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
      (el) => el.textContent === template.name,
    );
    act(() => {
      option?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    await flush();
  }

  beforeEach(() => {
    vi.useRealTimers();
    for (const fn of Object.values(api)) fn.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("shows a row per check with its state, and each kind of fix", async () => {
    api.checkTemplate.mockResolvedValue(
      result([
        ok("docker-cli"),
        {
          id: "docker-daemon",
          state: "bad",
          title: "Docker isn't running",
          detail: "Start Docker Desktop, then this updates on its own.",
          fix: { kind: "run", id: "open-docker", label: "Open Docker" },
        },
        { id: "docker-image", state: "todo", title: "Manor's host image is on this computer" },
      ]),
    );
    await open(docker);

    expect(q("start-host-check-docker-cli")?.dataset.state).toBe("ok");
    expect(q("start-host-check-docker-daemon")?.dataset.state).toBe("bad");
    expect(q("start-host-check-docker-daemon")?.textContent).toContain("Start Docker Desktop");
    expect(q("start-host-check-docker-image")?.dataset.state).toBe("todo");
    // A run fix is a button, by its own id.
    expect(q("start-host-fix-open-docker")?.tagName).toBe("BUTTON");
    expect(q("start-host-fix-open-docker")?.textContent).toBe("Open Docker");
    // Docker shows no fields up front: everything is under Advanced.
    expect(q("start-host-field-name")).toBeNull();
  });

  it("renders a url fix as a link, by the check's id", async () => {
    api.checkTemplate.mockResolvedValue(
      result([
        {
          id: "docker-cli",
          state: "bad",
          title: "Docker isn't installed",
          fix: { kind: "url", label: "Get Docker Desktop", href: "https://docs.docker.com/get-started/get-docker/" },
        },
      ]),
    );
    await open(docker);

    const link = q("start-host-fix-docker-cli") as HTMLAnchorElement;
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("https://docs.docker.com/get-started/get-docker/");
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("keeps Start disabled until every check is ok", async () => {
    api.checkTemplate.mockResolvedValueOnce(
      result([ok("docker-cli"), { id: "docker-daemon", state: "bad", title: "Docker isn't running" }]),
    );
    await open(docker);
    expect(submit().disabled).toBe(true);
    expect(q("start-host-gate-hint")?.textContent).toBe("Fix the items above to start.");

    api.checkTemplate.mockResolvedValue(result([ok("docker-cli"), ok("docker-daemon"), ok("docker-image")]));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await flush();
    expect(submit().disabled).toBe(false);
    expect(q("start-host-gate-hint")).toBeNull();
  });

  it("keeps Start disabled while the checks are still loading", async () => {
    api.checkTemplate.mockReturnValue(new Promise(() => {}));
    await open(docker);
    expect(q("start-host-checks-loading")).not.toBeNull();
    expect(submit().disabled).toBe(true);
  });

  it("keeps Start disabled while a required field is blank, and says where it is", async () => {
    api.checkTemplate.mockResolvedValue(result([ok("kubectl")]));
    await open(kubernetes);
    expect(submit().disabled).toBe(true);
    expect(q("start-host-gate-hint")?.textContent).toBe("Fill in Cluster to start.");
  });

  it("re-checks at once after filling a suggested cluster", async () => {
    api.checkTemplate
      .mockResolvedValueOnce(
        result([{ id: "cluster", state: "todo", title: "Choose a cluster" }], { defaults: { context: "kind-dev" } }),
      )
      .mockResolvedValue(result([ok("cluster")], { defaults: { context: "kind-dev" } }));
    await open(kubernetes);
    await flush();

    expect(api.checkTemplate).toHaveBeenCalledTimes(2);
    expect(api.checkTemplate.mock.calls[1][1]).toMatchObject({ context: "kind-dev" });
    expect(q("start-host-check-cluster")?.dataset.state).toBe("ok");
    expect(submit().disabled).toBe(false);
  });

  it("renders a multi field as checkboxes that edit a comma-separated answer", async () => {
    api.checkTemplate.mockResolvedValue(result([]));
    await open(docker);
    const claude = () => q("start-host-field-agents-claude");
    const codex = () => q("start-host-field-agents-codex");
    expect(q("start-host-field-agents")?.textContent).toContain("Claude Code");
    expect(claude()?.getAttribute("aria-checked")).toBe("true");
    expect(codex()?.getAttribute("aria-checked")).toBe("false");

    click(codex());
    expect(codex()?.getAttribute("aria-checked")).toBe("true");
    click(claude());
    expect(claude()?.getAttribute("aria-checked")).toBe("false");

    api.createRecipe.mockResolvedValue("docker-manor-abc123");
    api.addRecipeHost.mockResolvedValue({ hostId: "h1" });
    await act(async () => {
      submit().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(api.createRecipe.mock.calls[0][1]).toMatchObject({ agents: "codex" });
  });

  it("shows a field only while its showWhen answer holds, and only then requires it", async () => {
    api.checkTemplate.mockResolvedValue(result([ok("docker-cli")]));
    await open(docker);
    const where = q("start-host-field-where");
    expect(where?.textContent).toContain("This computer");
    // This computer: no SSH target, and nothing to fill in.
    expect(q("start-host-field-sshTarget")).toBeNull();
    expect(submit().disabled).toBe(false);

    const ssh = where?.querySelector<HTMLElement>('[data-value="ssh"]') ?? null;
    click(ssh);
    expect(ssh?.getAttribute("aria-checked")).toBe("true");
    const target = q("start-host-field-sshTarget") as HTMLInputElement;
    expect(target).not.toBeNull();
    expect(submit().disabled).toBe(true);
    expect(q("start-host-gate-hint")?.textContent).toBe("Fill in SSH target to start.");

    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(target, "me@build-box");
      target.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(submit().disabled).toBe(false);

    // Back to this computer: the target is hidden again, and kept.
    click(where?.querySelector<HTMLElement>('[data-value="local"]') ?? null);
    expect(q("start-host-field-sshTarget")).toBeNull();
    api.createRecipe.mockResolvedValue("docker-manor-abc123");
    api.addRecipeHost.mockResolvedValue({ hostId: "h1" });
    await act(async () => {
      submit().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(api.createRecipe.mock.calls[0][1]).toMatchObject({ where: "local", sshTarget: "me@build-box" });
  });

  it("shows each size's resources in its option", async () => {
    api.checkTemplate.mockResolvedValue(result([]));
    await open(kubernetes);
    expect(q("start-host-field-size")?.textContent).toContain("Small· 1 CPU, 2 GiB");
  });

  it("hides advanced fields behind the disclosure", async () => {
    api.checkTemplate.mockResolvedValue(result([]));
    await open(kubernetes);
    expect(q("start-host-field-namespace")).toBeNull();
    expect(q("start-host-advanced")?.getAttribute("aria-expanded")).toBe("false");

    click(q("start-host-advanced"));
    expect(q("start-host-advanced")?.getAttribute("aria-expanded")).toBe("true");
    expect((q("start-host-field-namespace") as HTMLInputElement).value).toBe("manor");
  });

  it("applies a set fix to its field, opens Advanced, and re-checks with it", async () => {
    api.checkTemplate.mockResolvedValueOnce(
      result([
        {
          id: "storage-class",
          state: "bad",
          title: "The cluster has no default storage class",
          fix: { kind: "set", label: "Use standard", key: "storageClass", value: "standard" },
        },
      ]),
    );
    api.checkTemplate.mockResolvedValue(result([ok("storage-class")]));
    await open(kubernetes);

    click(q("start-host-fix-storage-class"));
    await flush();

    expect((q("start-host-field-storageClass") as HTMLInputElement).value).toBe("standard");
    expect(api.checkTemplate).toHaveBeenLastCalledWith(
      "kubernetes",
      expect.objectContaining({ storageClass: "standard" }),
    );
    expect(q("start-host-check-storage-class")?.dataset.state).toBe("ok");
  });

  it("runs a run fix, re-checks at once, then polls every 2 s while busy, and stops on unmount", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const missing: TemplateCheck = {
      id: "docker-image",
      state: "bad",
      title: "Manor's host image isn't on this computer",
      fix: { kind: "run", id: "pull-image", label: "Download it" },
    };
    const pulling: TemplateCheck = {
      id: "docker-image",
      state: "busy",
      title: "Getting Manor's host image",
      detail: "280 of 450 MB",
    };
    api.checkTemplate.mockResolvedValueOnce(result([missing])).mockResolvedValue(result([pulling]));
    api.runTemplateFix.mockResolvedValue(undefined);
    await open(docker);
    expect(api.checkTemplate).toHaveBeenCalledTimes(1);

    click(q("start-host-fix-pull-image"));
    await flush();
    expect(api.runTemplateFix).toHaveBeenCalledWith("docker", "pull-image", expect.any(Object));
    expect(api.checkTemplate).toHaveBeenCalledTimes(2);
    expect(q("start-host-check-docker-image")?.dataset.state).toBe("busy");
    expect(q("start-host-check-docker-image")?.textContent).toContain("280 of 450 MB");

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(api.checkTemplate).toHaveBeenCalledTimes(3);

    act(() => root.unmount());
    root = createRoot(container);
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(api.checkTemplate).toHaveBeenCalledTimes(3);
  });

  it("stops polling once nothing is busy", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    api.checkTemplate
      .mockResolvedValueOnce(result([{ id: "docker-image", state: "busy", title: "Getting Manor's host image" }]))
      .mockResolvedValue(result([ok("docker-image")]));
    await open(docker);
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(api.checkTemplate).toHaveBeenCalledTimes(2);
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(api.checkTemplate).toHaveBeenCalledTimes(2);
  });

  it("shows the cluster guide while kubectl knows of no cluster, and leaves it when one appears", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    api.checkTemplate
      .mockResolvedValueOnce(result([ok("kubectl-cli")], { choices: { context: [] } }))
      .mockResolvedValue(
        result([ok("kubectl-cli"), ok("k8s-cluster")], {
          choices: { context: [{ value: "kind-dev", label: "kind-dev" }] },
        }),
      );
    await open(kubernetes);
    expect(q("cluster-guide")).not.toBeNull();
    expect(q("start-host-submit")).toBeNull();
    expect(q("start-host-field-context")).toBeNull();
    expect(q("cluster-guide")?.textContent).toContain("doctl kubernetes cluster kubeconfig save");
    expect(q("cluster-guide")?.querySelector("a")?.getAttribute("href")).toMatch(/^https:\/\//);

    // It asks again every 3 s, not sooner.
    await act(async () => {
      vi.advanceTimersByTime(2900);
    });
    expect(api.checkTemplate).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(api.checkTemplate).toHaveBeenCalledTimes(2);
    expect(q("cluster-guide")).toBeNull();
    expect(q("start-host-submit")).not.toBeNull();

    // Having left the guide, it stops asking.
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(api.checkTemplate).toHaveBeenCalledTimes(2);
  });

  it("explains a missing kubectl in the checklist, not the guide", async () => {
    api.checkTemplate.mockResolvedValue(
      result([{ id: "kubectl-cli", state: "bad", title: "kubectl isn't installed" }], {
        choices: { context: [] },
      }),
    );
    await open(kubernetes);
    expect(q("cluster-guide")).toBeNull();
    expect(q("start-host-check-kubectl-cli")).not.toBeNull();
  });
});
