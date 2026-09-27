/**
 * Build the `HostProvider` a persisted `HostSpec` describes (ADR-178 §1).
 * The one place a new provider kind is wired in.
 */

import type { BootstrapProgress } from "../remote-bootstrap";
import type { HostSpec } from "../types";
import { SshHostProvider } from "./ssh-provider";
import type { HostProvider } from "./types";

export interface CreateProviderOptions {
  /** Bootstrap progress while the provider's transport sets up the host. */
  onBootstrapProgress?: (progress: BootstrapProgress) => void;
}

export function createProvider(
  spec: HostSpec,
  opts: CreateProviderOptions = {},
): HostProvider {
  switch (spec.kind) {
    case "ssh":
      return new SshHostProvider(spec.target, {
        onBootstrapProgress: opts.onBootstrapProgress,
      });
  }
}
