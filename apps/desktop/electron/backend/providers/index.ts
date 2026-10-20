/**
 * Build the `HostProvider` a persisted `HostSpec` describes.
 * The one place a new provider kind is wired in.
 */

import type { BootstrapProgress } from "../remote-bootstrap";
import type { HostSpec } from "../types";
import { RecipeHostProvider } from "./recipe-provider";
import { SshHostProvider } from "./ssh-provider";
import type { HostProvider } from "./types";

export interface CreateProviderOptions {
  /** The host the provider is for. Required for a recipe host, whose commands are told it. */
  hostId?: string;
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
    case "recipe":
      if (!opts.hostId) throw new Error("A recipe host's provider needs its host id");
      return new RecipeHostProvider(opts.hostId, spec.recipeId, {
        onBootstrapProgress: opts.onBootstrapProgress,
      });
  }
}
