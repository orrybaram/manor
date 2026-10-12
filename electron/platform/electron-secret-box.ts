/**
 * `SecretBox` over Electron's `safeStorage`. Electron-only: the host server
 * never imports this (see `secret-box.ts`).
 */
import { safeStorage } from "electron";

import type { SecretBox } from "./secret-box";

export const electronSecretBox: SecretBox = {
  available: () => safeStorage.isEncryptionAvailable(),
  backend: () => "safeStorage",
  // The payloads are JSON or API-key text, so the string API's UTF-8 is exact.
  encrypt: async (plain) => safeStorage.encryptString(plain.toString("utf8")),
  decrypt: async (sealed) =>
    Buffer.from(safeStorage.decryptString(sealed), "utf8"),
};
