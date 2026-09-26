/**
 * A typed listener fan-out (ADR-183). `on` returns the unsubscribe; `emit`
 * calls every listener, logging one that throws instead of letting it stop
 * the rest.
 */
export class Emitter<A extends unknown[]> {
  private readonly listeners = new Set<(...args: A) => void>();

  /** `label` names the listeners in the log line, e.g. "[x] status listener". */
  constructor(private readonly label: string) {}

  on(listener: (...args: A) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(...args: A): void {
    for (const listener of this.listeners) {
      try {
        listener(...args);
      } catch (err) {
        console.error(`${this.label} threw:`, err);
      }
    }
  }

  get size(): number {
    return this.listeners.size;
  }
}
