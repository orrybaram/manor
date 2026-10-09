import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { TypeSafeManager, JEV_MODEL } from "./typesafe";

vi.mock("electron", () => ({
  safeStorage: {
    encryptString: vi.fn((s: string) => Buffer.from(`enc:${s}`)),
    decryptString: vi.fn((b: Buffer) => b.toString().replace("enc:", "")),
  },
}));

const mockReadFileSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockMkdirSync = vi.fn();
const mockUnlinkSync = vi.fn();

vi.mock("node:fs", () => ({
  default: {
    readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
    writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
    mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
    unlinkSync: (...args: unknown[]) => mockUnlinkSync(...args),
  },
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function reply(body: unknown, status = 200, statusText = "OK") {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: vi.fn().mockResolvedValue(body),
  };
}

const OPTIONS = { a: "Folder A", b: "Folder B" };
const REQ = { state: { workspaceName: "x" }, instructions: "pick", options: OPTIONS };

describe("TypeSafeManager", () => {
  let manager: TypeSafeManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    mockReadFileSync.mockReturnValue(Buffer.from("enc:sk-test"));
    manager = new TypeSafeManager();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stores the key encrypted and reports connected", () => {
    manager.saveKey("sk-test");
    expect(mockMkdirSync).toHaveBeenCalled();
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining("typesafe-key.enc"),
      Buffer.from("enc:sk-test"),
    );
    expect(manager.isConnected()).toBe(true);
  });

  it("is not connected without a key file", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(manager.getKey()).toBeNull();
    expect(manager.isConnected()).toBe(false);
  });

  it("verify sends GET /v1/models with the bearer key", async () => {
    mockFetch.mockResolvedValue(reply({}));
    await manager.verify();
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.typesafe.ai/v1/models");
    expect(init.method).toBe("GET");
    expect(init.headers.Authorization).toBe("Bearer sk-test");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("verify throws on a rejected key", async () => {
    mockFetch.mockResolvedValue(reply({}, 401, "Unauthorized"));
    await expect(manager.verify()).rejects.toThrow(
      "TypeSafe API error: 401 Unauthorized",
    );
  });

  it("choice posts the question and parses the answer", async () => {
    mockFetch.mockResolvedValue(
      reply({
        answers: {
          pick: { choice: "a", probabilities: { a: "0.9" }, confidence: "0.9" },
        },
      }),
    );
    const out = await manager.choice(REQ);
    expect(out).toEqual({
      choice: "a",
      probabilities: { a: 0.9, b: 0 },
      confidence: 0.9,
    });
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer sk-test");
    expect(JSON.parse(init.body)).toEqual({
      model: JEV_MODEL,
      state: { workspaceName: "x" },
      questions: {
        pick: { type: "choice", instructions: "pick", criteria: OPTIONS },
      },
    });
  });

  it("retries 429 then succeeds", async () => {
    vi.useFakeTimers();
    mockFetch
      .mockResolvedValueOnce(reply({}, 429, "Too Many"))
      .mockResolvedValueOnce(
        reply({ answers: { pick: { choice: "b", confidence: 0.8 } } }),
      );
    const p = manager.choice(REQ);
    await vi.runAllTimersAsync();
    expect((await p).choice).toBe("b");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("gives up after two retries", async () => {
    vi.useFakeTimers();
    mockFetch.mockResolvedValue(reply({}, 529, "Overloaded"));
    const p = manager.choice(REQ);
    const assertion = expect(p).rejects.toThrow("529");
    await vi.runAllTimersAsync();
    await assertion;
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("does not retry a 401", async () => {
    mockFetch.mockResolvedValue(reply({}, 401, "Unauthorized"));
    await expect(manager.choice(REQ)).rejects.toThrow("401");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("throws on an unknown choice", async () => {
    mockFetch.mockResolvedValue(
      reply({ answers: { pick: { choice: "zzz", confidence: 1 } } }),
    );
    await expect(manager.choice(REQ)).rejects.toThrow("unknown choice");
  });

  it("throws when the reply has no answer", async () => {
    mockFetch.mockResolvedValue(reply({}));
    await expect(manager.choice(REQ)).rejects.toThrow();
  });

  it("throws without a key", async () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    await expect(manager.choice(REQ)).rejects.toThrow("Not connected");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("throws on more than 255 options", async () => {
    const options = Object.fromEntries(
      Array.from({ length: 256 }, (_, i) => [`o${i}`, "d"]),
    );
    await expect(manager.choice({ ...REQ, options })).rejects.toThrow("255");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
