import { describe, it, expect } from "vitest";

import {
  ClaudeConnector,
  CodexConnector,
  PiConnector,
  OpencodeConnector,
  getConnector,
  getConnectorForCommand,
} from "../agent-connectors";

// ── ClaudeConnector ────────────────────────────────────────────────────────────

describe("ClaudeConnector.getResumeCommand", () => {
  const connector = new ClaudeConnector();
  const sessionId = "abc-123";

  it("appends --resume <sessionId> to the base command", () => {
    const result = connector.getResumeCommand("claude", sessionId);
    expect(result).toBe("claude --resume abc-123");
  });

  it("preserves flags like --dangerously-skip-permissions", () => {
    const base = "claude --dangerously-skip-permissions";
    const result = connector.getResumeCommand(base, sessionId);
    expect(result).toBe("claude --dangerously-skip-permissions --resume abc-123");
    expect(result).toContain("--dangerously-skip-permissions");
  });

  it("returns null for empty sessionId", () => {
    expect(connector.getResumeCommand("claude", "")).toBeNull();
  });

  it("does not double-append when --resume is already present", () => {
    const base = "claude --resume abc-123";
    expect(connector.getResumeCommand(base, sessionId)).toBe(base);
  });

  it("does not double-append when -r is already present", () => {
    const base = "claude -r abc-123";
    expect(connector.getResumeCommand(base, sessionId)).toBe(base);
  });

  it("does not double-append when --continue is already present", () => {
    const base = "claude --continue";
    expect(connector.getResumeCommand(base, sessionId)).toBe(base);
  });

  it("does not double-append when -c is already present", () => {
    const base = "claude -c";
    expect(connector.getResumeCommand(base, sessionId)).toBe(base);
  });

  it("does not false-positive on a path containing resume", () => {
    // A path token like /home/user/resume-project is not the same as --resume
    const base = "claude --model claude-opus-4";
    const result = connector.getResumeCommand(base, sessionId);
    expect(result).toBe("claude --model claude-opus-4 --resume abc-123");
  });
});

// ── CodexConnector ─────────────────────────────────────────────────────────────

describe("CodexConnector.getResumeCommand", () => {
  const connector = new CodexConnector();
  const sessionId = "sess-456";

  it("builds <binary> resume <sessionId> from the base command", () => {
    const result = connector.getResumeCommand("codex", sessionId);
    expect(result).toBe("codex resume sess-456");
  });

  it("uses the binary from a base command that includes --yolo", () => {
    // Codex intentionally drops top-level flags; only the binary is kept
    const result = connector.getResumeCommand("codex --yolo", sessionId);
    expect(result).toBe("codex resume sess-456");
  });

  it("returns null for empty sessionId", () => {
    expect(connector.getResumeCommand("codex", "")).toBeNull();
  });

  it("does not double-append when the resume subcommand is already present", () => {
    const base = "codex resume sess-456";
    expect(connector.getResumeCommand(base, sessionId)).toBe(base);
  });

  it("uses only the binary from a base command with a custom path", () => {
    const result = connector.getResumeCommand("/usr/local/bin/codex", sessionId);
    expect(result).toBe("/usr/local/bin/codex resume sess-456");
  });
});

// ── PiConnector ────────────────────────────────────────────────────────────────

describe("PiConnector.getResumeCommand", () => {
  const connector = new PiConnector();
  const sessionId = "pi-789";

  it("appends --session <sessionId> to the base command", () => {
    const result = connector.getResumeCommand("pi", sessionId);
    expect(result).toBe("pi --session pi-789");
  });

  it("preserves extra flags in the base command", () => {
    const base = "pi --verbose";
    const result = connector.getResumeCommand(base, sessionId);
    expect(result).toBe("pi --verbose --session pi-789");
    expect(result).toContain("--verbose");
  });

  it("returns null for empty sessionId", () => {
    expect(connector.getResumeCommand("pi", "")).toBeNull();
  });

  it("does not double-append when --session is already present", () => {
    const base = "pi --session pi-789";
    expect(connector.getResumeCommand(base, sessionId)).toBe(base);
  });
});

// ── OpencodeConnector ──────────────────────────────────────────────────────────

describe("OpencodeConnector.getResumeCommand", () => {
  const connector = new OpencodeConnector();
  const sessionId = "oc-abc";

  it("appends --session <sessionId> to the base command", () => {
    const result = connector.getResumeCommand("opencode", sessionId);
    expect(result).toBe("opencode --session oc-abc");
  });

  it("preserves extra flags in the base command", () => {
    const base = "opencode --model gpt-4o";
    const result = connector.getResumeCommand(base, sessionId);
    expect(result).toBe("opencode --model gpt-4o --session oc-abc");
    expect(result).toContain("--model gpt-4o");
  });

  it("returns null for empty sessionId", () => {
    expect(connector.getResumeCommand("opencode", "")).toBeNull();
  });

  it("does not double-append when --session is already present", () => {
    const base = "opencode --session oc-abc";
    expect(connector.getResumeCommand(base, sessionId)).toBe(base);
  });

  it("does not double-append when -s is already present", () => {
    const base = "opencode -s oc-abc";
    expect(connector.getResumeCommand(base, sessionId)).toBe(base);
  });

  it("does not double-append when --continue is already present", () => {
    const base = "opencode --continue";
    expect(connector.getResumeCommand(base, sessionId)).toBe(base);
  });

  it("does not double-append when -c is already present", () => {
    const base = "opencode -c";
    expect(connector.getResumeCommand(base, sessionId)).toBe(base);
  });
});

// ── OpencodeConnector kind and registry ───────────────────────────────────────

describe("OpencodeConnector kind", () => {
  it("has kind 'opencode'", () => {
    const connector = new OpencodeConnector();
    expect(connector.kind).toBe("opencode");
  });

  it("has defaultCommand 'opencode'", () => {
    const connector = new OpencodeConnector();
    expect(connector.defaultCommand).toBe("opencode");
  });
});

describe("getConnector registry", () => {
  it("returns OpencodeConnector (not Claude fallback) for 'opencode'", () => {
    const connector = getConnector("opencode");
    expect(connector.kind).toBe("opencode");
    expect(connector).toBeInstanceOf(OpencodeConnector);
  });

  it("still returns ClaudeConnector for 'claude'", () => {
    const connector = getConnector("claude");
    expect(connector.kind).toBe("claude");
    expect(connector).toBeInstanceOf(ClaudeConnector);
  });

  it("still returns CodexConnector for 'codex'", () => {
    const connector = getConnector("codex");
    expect(connector.kind).toBe("codex");
    expect(connector).toBeInstanceOf(CodexConnector);
  });

  it("still returns PiConnector for 'pi'", () => {
    const connector = getConnector("pi");
    expect(connector.kind).toBe("pi");
    expect(connector).toBeInstanceOf(PiConnector);
  });
});

// ── Fork ───────────────────────────────────────────────────────────────────────

describe("getForkCommand", () => {
  it("claude resumes the session into a new one with --fork-session", () => {
    expect(new ClaudeConnector().getForkCommand("claude --dangerously-skip-permissions", "abc-123", "/t.jsonl")).toBe(
      "claude --dangerously-skip-permissions --resume abc-123 --fork-session",
    );
  });

  it("codex forks with its subcommand, keeping the user's flags", () => {
    expect(new CodexConnector().getForkCommand("codex --yolo", "abc-123", "/t.jsonl")).toBe(
      "codex --yolo fork abc-123",
    );
  });

  it("opencode forks with --session <id> --fork", () => {
    expect(new OpencodeConnector().getForkCommand("opencode", "ses_1", "")).toBe("opencode --session ses_1 --fork");
  });

  it("pi forks the session file", () => {
    expect(new PiConnector().getForkCommand("pi", "abc", "/home/me/.pi/agent/sessions/x/a b.jsonl")).toBe(
      "pi --fork '/home/me/.pi/agent/sessions/x/a b.jsonl'",
    );
    expect(new PiConnector().getForkCommand("pi", "abc", "")).toBeNull();
  });

  it("has nothing to fork without a session id", () => {
    for (const kind of ["claude", "codex", "opencode"] as const) {
      expect(getConnector(kind).getForkCommand(getConnector(kind).defaultCommand, "", "/t")).toBeNull();
    }
  });

  it("quotes an id the shell would read as more than a word", () => {
    expect(new ClaudeConnector().getForkCommand("claude", "x; rm -rf ~", "")).toBe(
      "claude --resume 'x; rm -rf ~' --fork-session",
    );
    expect(new CodexConnector().getResumeCommand("codex", "$(id)")).toBe("codex resume '$(id)'");
  });
});

describe("withoutSessionArgs", () => {
  it("drops whatever picks a session, keeping the rest", () => {
    expect(new ClaudeConnector().withoutSessionArgs("claude -c --model opus")).toBe("claude --model opus");
    expect(new ClaudeConnector().withoutSessionArgs("claude --resume abc --dangerously-skip-permissions")).toBe(
      "claude --dangerously-skip-permissions",
    );
    expect(new ClaudeConnector().withoutSessionArgs("claude -r --verbose")).toBe("claude --verbose");
    expect(new OpencodeConnector().withoutSessionArgs("opencode -s ses_1 --model x")).toBe("opencode --model x");
    expect(new OpencodeConnector().withoutSessionArgs("opencode --session=ses_1 -c")).toBe("opencode");
    expect(new PiConnector().withoutSessionArgs("pi --session /a.jsonl --thinking high")).toBe("pi --thinking high");
    expect(new CodexConnector().withoutSessionArgs("codex --yolo resume --last")).toBe("codex --yolo");
    expect(new CodexConnector().withoutSessionArgs("codex --yolo")).toBe("codex --yolo");
  });
});

describe("getConnectorForCommand", () => {
  it("names the agent after a leading cd", () => {
    expect(getConnectorForCommand("cd '/repo/my api' && codex resume t1").kind).toBe("codex");
    expect(getConnectorForCommand("cd /a && cd \"/b c\" && pi --session x").kind).toBe("pi");
    expect(getConnectorForCommand("opencode --session x").kind).toBe("opencode");
  });
});
