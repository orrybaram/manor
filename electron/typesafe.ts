import fs from "node:fs";
import path from "node:path";
import { safeStorage } from "electron";

import { typesafeKeyFile } from "./paths";

/** The Jev model every question is sent to. One constant, so it is easy to bump. */
export const JEV_MODEL = "jev-1.13.0";

const BASE_URL = "https://api.typesafe.ai";
const REQUEST_TIMEOUT_MS = 5000;
/** Waits before each retry of a busy (429/529) reply; its length is the retry count. */
const RETRY_DELAYS_MS = [250, 500];
const MAX_CHOICE_OPTIONS = 255;

export interface ChoiceAnswer {
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface ChoiceRequest {
  state: unknown;
  instructions: string;
  options: Record<string, string>;
}

export class TypeSafeManager {
  private keyPath: string;

  constructor() {
    this.keyPath = typesafeKeyFile();
  }

  saveKey(key: string): void {
    const encrypted = safeStorage.encryptString(key);
    fs.mkdirSync(path.dirname(this.keyPath), { recursive: true });
    fs.writeFileSync(this.keyPath, encrypted);
  }

  getKey(): string | null {
    try {
      const encrypted = fs.readFileSync(this.keyPath);
      return safeStorage.decryptString(encrypted);
    } catch {
      return null;
    }
  }

  clearKey(): void {
    try {
      fs.unlinkSync(this.keyPath);
    } catch {
      // file may not exist
    }
  }

  isConnected(): boolean {
    return this.getKey() !== null;
  }

  /** A cheap authenticated call: throws unless the saved key is accepted. */
  async verify(): Promise<void> {
    await this.request("/v1/models", { method: "GET" });
  }

  /** Ask Jev to pick one of `options` (option key -> description) for `state`. */
  async choice({
    state,
    instructions,
    options,
  }: ChoiceRequest): Promise<ChoiceAnswer> {
    const keys = Object.keys(options);
    if (keys.length > MAX_CHOICE_OPTIONS) {
      throw new Error(
        `Jev allows at most ${MAX_CHOICE_OPTIONS} options, got ${keys.length}`,
      );
    }

    const res = await this.request("/v1/systemone", {
      method: "POST",
      body: JSON.stringify({
        model: JEV_MODEL,
        state,
        questions: {
          pick: { type: "choice", instructions, criteria: options },
        },
      }),
    });

    const json = (await res.json()) as {
      answers?: { pick?: unknown };
    } | null;
    const pick = json?.answers?.pick;
    if (!pick || typeof pick !== "object") {
      throw new Error("TypeSafe API returned no answer");
    }
    const answer = pick as {
      choice?: unknown;
      probabilities?: Record<string, unknown> | null;
      confidence?: unknown;
    };
    if (typeof answer.choice !== "string" || !keys.includes(answer.choice)) {
      throw new Error(
        `TypeSafe API returned an unknown choice: ${String(answer.choice)}`,
      );
    }

    const probabilities: Record<string, number> = {};
    for (const key of keys) {
      probabilities[key] = Number(answer.probabilities?.[key] ?? 0);
    }
    return {
      choice: answer.choice,
      probabilities,
      confidence: Number(answer.confidence),
    };
  }

  private async request(
    pathname: string,
    init: { method: string; body?: string },
  ): Promise<Response> {
    const key = this.getKey();
    if (!key) throw new Error("Not connected to TypeSafe");

    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${BASE_URL}${pathname}`, {
        method: init.method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: init.body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.ok) return res;

      const busy = res.status === 429 || res.status === 529;
      if (busy && attempt < RETRY_DELAYS_MS.length) {
        await new Promise((resolve) =>
          setTimeout(resolve, RETRY_DELAYS_MS[attempt]),
        );
        continue;
      }
      throw new Error(`TypeSafe API error: ${res.status} ${res.statusText}`);
    }
  }
}
