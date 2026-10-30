import { describe, expect, it, vi } from "vitest";

import { createPermissionPolicy, type PromptRequest } from "./permission-policy";

/** The requester is a label here; "app" plays one of Manor's own windows. */
type Requester = "app" | "guest";

const APP_URL = "file:///Applications/Manor.app/dist/index.html";
const PAGE = "https://example.com/some/page";

function setup(answer: boolean | (() => Promise<boolean>) = true) {
  const prompt = vi.fn(
    (_requester: Requester, _request: PromptRequest): Promise<boolean> =>
      typeof answer === "function" ? answer() : Promise.resolve(answer),
  );
  const policy = createPermissionPolicy<Requester>({
    isAppWindow: (requester, url) => requester === "app" && url === APP_URL,
    prompt,
  });
  return { policy, prompt };
}

describe("permission policy", () => {
  describe("Manor's own windows", () => {
    it.each(["clipboard-read", "clipboard-sanitized-write", "media", "notifications", "fullscreen"])(
      "grants %s without asking",
      async (permission) => {
        const { policy, prompt } = setup();
        await expect(
          policy.request("app", { permission, requestingUrl: APP_URL, mediaTypes: ["video"] }),
        ).resolves.toBe(true);
        expect(policy.check("app", { permission, requestingUrl: APP_URL })).toBe(true);
        expect(prompt).not.toHaveBeenCalled();
      },
    );

    it.each(["geolocation", "midi", "hid", "display-capture", "openExternal", "pointerLock"])(
      "denies %s, which the renderer doesn't use",
      async (permission) => {
        const { policy, prompt } = setup();
        await expect(policy.request("app", { permission, requestingUrl: APP_URL })).resolves.toBe(
          false,
        );
        expect(policy.check("app", { permission, requestingUrl: APP_URL })).toBe(false);
        expect(prompt).not.toHaveBeenCalled();
      },
    );

    it("treats an app window showing another page as a page", async () => {
      const { policy, prompt } = setup(false);
      await expect(
        policy.request("app", { permission: "clipboard-read", requestingUrl: PAGE }),
      ).resolves.toBe(false);
      expect(prompt).toHaveBeenCalledTimes(1);
    });
  });

  describe("pages", () => {
    it.each(["clipboard-sanitized-write", "fullscreen", "pointerLock"])(
      "grants %s without asking",
      async (permission) => {
        const { policy, prompt } = setup();
        await expect(policy.request("guest", { permission, requestingUrl: PAGE })).resolves.toBe(
          true,
        );
        expect(policy.check("guest", { permission, requestingUrl: PAGE })).toBe(true);
        expect(prompt).not.toHaveBeenCalled();
      },
    );

    it.each(["midi", "midiSysex", "hid", "usb", "serial", "display-capture", "idle-detection", "unknown"])(
      "denies %s without asking",
      async (permission) => {
        const { policy, prompt } = setup();
        await expect(policy.request("guest", { permission, requestingUrl: PAGE })).resolves.toBe(
          false,
        );
        expect(policy.check("guest", { permission, requestingUrl: PAGE })).toBe(false);
        expect(prompt).not.toHaveBeenCalled();
      },
    );

    it.each([
      ["geolocation", {}, "know your location"],
      ["notifications", {}, "show notifications"],
      ["clipboard-read", {}, "see what you copy to the clipboard"],
      ["local-network-access", {}, "connect to devices and services on your computer and local network"],
      ["loopback-network", {}, "connect to devices and services on your computer and local network"],
      ["media", { mediaTypes: ["video"] }, "use your camera"],
      ["media", { mediaTypes: ["audio", "video"] }, "use your microphone and your camera"],
      ["openExternal", { externalUrl: "mailto:a@example.com" }, "open mailto: links in another app"],
    ] as const)("asks before granting %s", async (permission, extra, action) => {
      const { policy, prompt } = setup(true);
      await expect(
        policy.request("guest", { permission, requestingUrl: PAGE, ...extra }),
      ).resolves.toBe(true);
      expect(prompt).toHaveBeenCalledWith("guest", {
        site: "example.com",
        origin: "https://example.com",
        action,
      });
    });

    it("denies when the user blocks", async () => {
      const { policy } = setup(false);
      await expect(
        policy.request("guest", { permission: "geolocation", requestingUrl: PAGE }),
      ).resolves.toBe(false);
      expect(policy.check("guest", { permission: "geolocation", requestingUrl: PAGE })).toBe(false);
    });

    it("denies when the prompt fails", async () => {
      const { policy } = setup(() => Promise.reject(new Error("no window")));
      await expect(
        policy.request("guest", { permission: "geolocation", requestingUrl: PAGE }),
      ).resolves.toBe(false);
    });

    it("remembers an answer per origin, and only for that origin", async () => {
      const { policy, prompt } = setup(true);
      await policy.request("guest", { permission: "geolocation", requestingUrl: PAGE });
      await policy.request("guest", {
        permission: "geolocation",
        requestingUrl: "https://example.com/other",
      });
      expect(prompt).toHaveBeenCalledTimes(1);
      expect(policy.check("guest", { permission: "geolocation", requestingUrl: PAGE })).toBe(true);

      expect(
        policy.check("guest", { permission: "geolocation", requestingUrl: "https://other.example" }),
      ).toBe(false);
      await policy.request("guest", {
        permission: "geolocation",
        requestingUrl: "https://other.example",
      });
      expect(prompt).toHaveBeenCalledTimes(2);
    });

    it("remembers a block too", async () => {
      const { policy, prompt } = setup(false);
      await policy.request("guest", { permission: "notifications", requestingUrl: PAGE });
      await policy.request("guest", { permission: "notifications", requestingUrl: PAGE });
      expect(prompt).toHaveBeenCalledTimes(1);
    });

    it("never reports a prompted permission as granted before it is allowed", () => {
      const { policy } = setup(true);
      for (const permission of ["media", "geolocation", "notifications", "clipboard-read"]) {
        expect(policy.check("guest", { permission, requestingUrl: PAGE })).toBe(false);
      }
    });

    it("asks once for identical requests made while the prompt is open", async () => {
      let resolve!: (allowed: boolean) => void;
      const { policy, prompt } = setup(() => new Promise((r) => (resolve = r)));
      const first = policy.request("guest", { permission: "geolocation", requestingUrl: PAGE });
      const second = policy.request("guest", { permission: "geolocation", requestingUrl: PAGE });
      resolve(true);
      await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
      expect(prompt).toHaveBeenCalledTimes(1);
    });

    it("keeps camera and microphone apart", async () => {
      const { policy, prompt } = setup(true);
      await policy.request("guest", { permission: "media", requestingUrl: PAGE, mediaTypes: ["audio"] });
      expect(policy.check("guest", { permission: "media", requestingUrl: PAGE, mediaType: "audio" })).toBe(
        true,
      );
      expect(policy.check("guest", { permission: "media", requestingUrl: PAGE, mediaType: "video" })).toBe(
        false,
      );

      // Asking for both now prompts only for the camera.
      await policy.request("guest", {
        permission: "media",
        requestingUrl: PAGE,
        mediaTypes: ["audio", "video"],
      });
      expect(prompt).toHaveBeenCalledTimes(2);
      expect(prompt.mock.calls[1][1].action).toBe("use your camera");
    });

    it("keeps external link schemes apart", async () => {
      const { policy, prompt } = setup(true);
      await policy.request("guest", {
        permission: "openExternal",
        requestingUrl: PAGE,
        externalUrl: "mailto:a@example.com",
      });
      await policy.request("guest", {
        permission: "openExternal",
        requestingUrl: PAGE,
        externalUrl: "zoommtg://join",
      });
      expect(prompt).toHaveBeenCalledTimes(2);
    });

    it.each(["", "data:text/html,hi", "about:blank", "not a url"])(
      "denies a prompted permission from an opaque origin (%j) without asking",
      async (requestingUrl) => {
        const { policy, prompt } = setup(true);
        await expect(
          policy.request("guest", { permission: "geolocation", requestingUrl }),
        ).resolves.toBe(false);
        expect(prompt).not.toHaveBeenCalled();
      },
    );

    it("denies media with no recognised device type without asking", async () => {
      const { policy, prompt } = setup(true);
      await expect(
        policy.request("guest", { permission: "media", requestingUrl: PAGE, mediaTypes: [] }),
      ).resolves.toBe(false);
      expect(prompt).not.toHaveBeenCalled();
    });
  });
});
