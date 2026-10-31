import type { AgentStatus, ChatTurnState } from "../../../electron.d";

/** How long the transcript must say the turn ended before the chat believes it over hooks. */
export const TURN_SETTLE_MS = 3_000;

/** The hook status the chat shows as Claude at work. */
export function isBusyStatus(status: AgentStatus | null): boolean {
  return status === "thinking" || status === "working";
}

function ended(turn: ChatTurnState | null): boolean {
  return turn === "done" || turn === "interrupted";
}

/**
 * Whether the chat may stop showing Claude at work although the hook status
 * still says busy: the transcript ended the turn (`done` or `interrupted`)
 * after the hooks' busy stretch began, and has said so for `settleMs`
 * straight. A Stop hook that went missing would otherwise leave the phone
 * on its live line ("Tending… 12s") for good.
 *
 * A turn that had already ended when the busy stretch began never settles
 * it: a prompt just sent goes busy before its line reaches the transcript,
 * however long that takes. Flaps between working and thinking stay one
 * stretch. Newer transcript activity, or the hooks going idle, clears it.
 * Display only: hook signals stay the agent status everywhere else.
 */
export class TurnSettle {
  /** Undefined until the first status: a stretch already busy then began before anything. */
  private status: AgentStatus | null | undefined = undefined;
  private turn: ChatTurnState | null = null;
  /** Orders a busy stretch's start against a turn's end, whatever the clock says. */
  private seq = 0;
  /** When the current busy stretch began; 0 for one under way when first told. */
  private busySince = 0;
  /** When the turn last ended; null while it hasn't. */
  private turnEndedAt: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private current = false;

  constructor(
    private readonly onChange: (settled: boolean) => void,
    private readonly settleMs = TURN_SETTLE_MS,
  ) {}

  /** True once the transcript's ended turn outranks a busy hook status. */
  get settled(): boolean {
    return this.current;
  }

  setStatus(status: AgentStatus | null): void {
    if (status === this.status) return;
    const first = this.status === undefined;
    const wasBusy = !first && isBusyStatus(this.status ?? null);
    this.status = status;
    if (!isBusyStatus(status)) {
      this.set(false);
      return;
    }
    if (!wasBusy) {
      this.busySince = first ? 0 : ++this.seq;
      this.set(false);
    }
  }

  setTurn(turn: ChatTurnState | null): void {
    if (turn === this.turn) return;
    this.turn = turn;
    this.dispose();
    this.set(false);
    if (!ended(turn)) {
      this.turnEndedAt = null;
      return;
    }
    this.turnEndedAt = ++this.seq;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.set(this.endedThisStretch());
    }, this.settleMs);
  }

  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private endedThisStretch(): boolean {
    return (
      isBusyStatus(this.status ?? null) &&
      this.turnEndedAt !== null &&
      this.turnEndedAt > this.busySince
    );
  }

  private set(next: boolean): void {
    if (next === this.current) return;
    this.current = next;
    this.onChange(next);
  }
}
