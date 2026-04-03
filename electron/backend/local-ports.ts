import type { ActivePort, PortsBackend } from "./types";

export class LocalPortsBackend implements PortsBackend {
  async scan(_workspacePaths: string[]): Promise<ActivePort[]> {
    throw new Error("Not implemented");
  }

  async kill(_pid: number): Promise<void> {
    throw new Error("Not implemented");
  }
}
