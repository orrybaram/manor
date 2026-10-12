import { plainFileSecretBox, type SecretBox } from "../secret-box";

/** A plaintext box whose availability a test can flip, like a locked keychain. */
export function switchableBox(): SecretBox & { setAvailable(v: boolean): void } {
  let available = true;
  return {
    ...plainFileSecretBox,
    available: () => available,
    setAvailable: (v) => {
      available = v;
    },
  };
}
