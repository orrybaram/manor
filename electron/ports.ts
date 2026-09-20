import type { ActivePort, PortsBackend } from "./backend/types";
import { publishRendererBroadcast } from "./renderer-broadcast";

export type { ActivePort };

export class PortScanner {
  private workspacePaths: string[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastPorts: ActivePort[] = [];
  private scanning = false;
  private backend: PortsBackend;

  constructor(backend: PortsBackend) {
    this.backend = backend;
  }

  /** ADR-180 D5: publishes `ports.changed` instead of pushing at a window. */
  start(onScan?: (ports: ActivePort[]) => ActivePort[]): void {
    this.stop();

    this.timer = setInterval(async () => {
      if (this.scanning) return;
      this.scanning = true;
      try {
        const ports = await this.backend.scan(this.workspacePaths);
        const enriched = onScan ? onScan(ports) : ports;
        if (JSON.stringify(enriched) !== JSON.stringify(this.lastPorts)) {
          publishRendererBroadcast("ports", "changed", enriched);
          this.lastPorts = enriched;
        }
      } finally {
        this.scanning = false;
      }
    }, 3000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  updateWorkspacePaths(paths: string[]): void {
    this.workspacePaths = paths;
  }

  async scanNow(): Promise<ActivePort[]> {
    return this.backend.scan(this.workspacePaths);
  }
}
