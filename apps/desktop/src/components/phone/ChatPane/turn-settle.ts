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
 * still says busy: the transcript has said the turn ended (`done` or
 * `interrupted`) for `settleMs` straight. A Stop hook that went missing
 * would otherwise leave the phone on "Thinking" for good.
 *
 * Any change of either side starts over: newer transcript activity, or the
 * hook status moving. Telling it the same value again changes nothing.
 * Display only: hook signals stay the agent status everywhere else.
 */
export class TurnSettle {
  private status: AgentStatus | null = null;
  private turn: ChatTurnState | null = null;
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
    this.status = status;
    this.restart();
  }

  setTurn(turn: ChatTurnState | null): void {
    if (turn === this.turn) return;
    this.turn = turn;
    this.restart();
  }

  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private restart(): void {
    this.dispose();
    this.set(false);
    if (!isBusyStatus(this.status) || !ended(this.turn)) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.set(true);
    }, this.settleMs);
  }

  private set(next: boolean): void {
    if (next === this.current) return;
    this.current = next;
    this.onChange(next);
  }
}
