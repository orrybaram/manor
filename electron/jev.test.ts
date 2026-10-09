import { describe, it, expect, vi } from "vitest";

import {
  base64urlDecode,
  generateRelayIdentity,
  verifyJevRequest,
  type RelayIdentity,
} from "../src/lib/relay-crypto";
import { JevClient } from "./jev";
import { EncryptionUnavailableError } from "./remote-control/devices";
import type { RelayIdentityStore } from "./remote-control/relay/identity";

vi.mock("electron", () => ({
  safeStorage: { isEncryptionAvailable: () => false },
}));

const QUESTION = {
  state: { workspaceName: "oauth", branchName: "feat/oauth" },
  options: { f1: 'Folder "Auth".', __none__: "Fits none of these folders" },
};

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

/** A store whose `load()` hands out copies, as the real one does. */
function fakeStore(identity = generateRelayIdentity()) {
  const loaded: RelayIdentity[] = [];
  const store = {
    load: () => {
      const copy: RelayIdentity = {
        ed25519: {
          pub: identity.ed25519.pub.slice(),
          priv: identity.ed25519.priv.slice(),
        },
        x25519: {
          pub: identity.x25519.pub.slice(),
          priv: identity.x25519.priv.slice(),
        },
      };
      loaded.push(copy);
      return copy;
    },
  } as unknown as RelayIdentityStore;
  return { identity, loaded, store };
}

function client(fetchImpl: typeof fetch, store = fakeStore().store) {
  return new JevClient({
    identityStore: () => store,
    baseUrl: () => "https://relay.test",
    fetch: fetchImpl,
  });
}

describe("JevClient", () => {
  it("posts a body that verifies with verifyJevRequest", async () => {
    const { identity, store } = fakeStore();
    const fetchMock = vi.fn(async () =>
      reply({ choice: "f1", confidence: 0.8 }),
    );
    const jev = client(fetchMock as unknown as typeof fetch, store);

    expect(await jev.suggest(QUESTION)).toEqual({
      choice: "f1",
      confidence: 0.8,
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://relay.test/jev/folder");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.v).toBe(1);
    expect(body.state).toEqual(QUESTION.state);
    expect(body.options).toEqual(QUESTION.options);
    expect(base64urlDecode(body.pub)).toEqual(identity.ed25519.pub);
    expect(
      verifyJevRequest(
        identity.ed25519.pub,
        body.ts,
        { state: body.state, options: body.options },
        base64urlDecode(body.sig),
      ),
    ).toBe(true);
  });

  it("wipes the private keys after signing", async () => {
    const { loaded, store } = fakeStore();
    const jev = client(
      (async () => reply({ choice: "f1", confidence: 0.8 })) as typeof fetch,
      store,
    );
    await jev.suggest(QUESTION);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].ed25519.priv.every((b) => b === 0)).toBe(true);
    expect(loaded[0].x25519.priv.every((b) => b === 0)).toBe(true);
  });

  it.each([400, 401, 429, 502, 503])("returns null on %i", async (status) => {
    const jev = client((async () =>
      reply({ error: "no" }, status)) as typeof fetch);
    expect(await jev.suggest(QUESTION)).toBeNull();
  });

  it("returns null for a choice that isn't an option", async () => {
    const jev = client((async () =>
      reply({ choice: "gone", confidence: 0.9 })) as typeof fetch);
    expect(await jev.suggest(QUESTION)).toBeNull();
  });

  it("returns null for a non-finite confidence", async () => {
    const jev = client((async () =>
      reply({ choice: "f1", confidence: "high" })) as typeof fetch);
    expect(await jev.suggest(QUESTION)).toBeNull();
  });

  it("disables itself when safeStorage can't encrypt", async () => {
    const load = vi.fn(() => {
      throw new EncryptionUnavailableError();
    });
    const fetchMock = vi.fn();
    const jev = client(
      fetchMock as unknown as typeof fetch,
      { load } as unknown as RelayIdentityStore,
    );
    expect(await jev.suggest(QUESTION)).toBeNull();
    expect(await jev.suggest(QUESTION)).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lets other errors propagate", async () => {
    const jev = client((async () => {
      throw new Error("offline");
    }) as typeof fetch);
    await expect(jev.suggest(QUESTION)).rejects.toThrow("offline");
  });
});
