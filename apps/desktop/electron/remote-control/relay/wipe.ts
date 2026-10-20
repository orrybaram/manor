import type { RelayIdentity } from "@manor/protocol/relay-crypto";

/** Overwrite the private keys in place. The identity is unusable afterwards. */
export function wipe(identity: RelayIdentity): void {
  identity.ed25519.priv.fill(0);
  identity.x25519.priv.fill(0);
}
