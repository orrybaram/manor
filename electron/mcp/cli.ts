/**
 * The `manor` CLI surface, generated from the same `ToolModule` definitions the
 * MCP entry (`mcp-webview-server.ts`) registers (ADR-170). Every subcommand,
 * flag, and help line is derived from a `ToolDef`; there is no hand-written
 * command table, so a tool added to a module becomes a subcommand for free and
 * the two surfaces cannot drift.
 *
 * `runCli` returns an exit code and never calls `process.exit`, so tests can
 * drive it with a fake `Http` and a capturing `CliIo`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { isConnectionError } from "./http-client";
import { moduleLabels, modules } from "./modules";
import type { Http, ToolDef, ToolModule, ToolResult } from "./types";
import { HttpError } from "./types";

/** Just enough of `process` for the CLI to write output — and for tests to capture it. */
export interface CliIo {
  stdout: { write(s: string): unknown };
  stderr: { write(s: string): unknown };
}

/** The JSON-Schema subset the tool modules actually use. */
interface PropSchema {
  type?: string;
  description?: string;
  items?: { type?: string };
}

/** Merged exactly the way the MCP entry merges them. */
const handlers: ToolModule["handlers"] = Object.assign(
  {},
  ...modules.map((m) => m.handlers),
);

/** A problem with the invocation rather than with Manor. Exits `2`. */
class UsageError extends Error {}

// ── Name derivation ──

/** Tool `list_projects` → subcommand `list-projects`. */
export function toCommandName(toolName: string): string {
  return toolName.replace(/_/g, "-");
}

/** Schema property `projectId` → flag `--project-id`. */
export function toFlagName(prop: string): string {
  return prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/** Built once: subcommand → the `ToolDef` it was generated from. */
const commands = new Map<string, ToolDef>(
  modules
    .flatMap((m) => m.tools)
    .map((tool) => [toCommandName(tool.name), tool] as [string, ToolDef]),
);

/** The generated subcommand table, exposed for tests and for `--help`. */
export function commandTable(): ReadonlyMap<string, ToolDef> {
  return commands;
}

function properties(tool: ToolDef): Record<string, PropSchema> {
  return (
    (tool.inputSchema.properties as Record<string, PropSchema> | undefined) ??
    {}
  );
}

function requiredProps(tool: ToolDef): string[] {
  return (tool.inputSchema.required as string[] | undefined) ?? [];
}

// ── Help ──

const API_USAGE = "manor api <GET|POST|DELETE> <path> [--body '<json>']";
const API_SUMMARY =
  "Send a raw request to Manor's control server and print the JSON reply.";

/**
 * Text up to the first `. ` (inclusive) or the whole string. Keeps
 * `manor --help` to a fraction of the MCP roster's token cost.
 */
function firstSentence(description: string): string {
  const end = description.indexOf(". ");
  return end === -1 ? description : description.slice(0, end + 1);
}

function pad(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - value.length));
}

function renderGlobalHelp(): string {
  const lines = [
    "manor — Manor's control surface as a shell command.",
    "",
    "Usage: manor <command> [flags]",
    "       manor <command> --help",
    `       ${API_USAGE}`,
  ];

  const width = Math.max(
    ...Array.from(commands.keys(), (command) => command.length),
  );

  modules.forEach((mod, i) => {
    lines.push("", `${moduleLabels[i]}:`);
    for (const tool of mod.tools) {
      const command = toCommandName(tool.name);
      lines.push(
        `  ${pad(command, width)}  ${firstSentence(tool.description)}`,
      );
    }
  });

  lines.push("", `  ${pad("api", width)}  ${API_SUMMARY}`, "");
  return lines.join("\n");
}

function renderCommandHelp(command: string, tool: ToolDef): string {
  const props = properties(tool);
  const required = requiredProps(tool);
  const lines = [`Usage: manor ${command} [flags]`, "", tool.description];

  const entries = Object.entries(props);
  if (entries.length > 0) {
    const labels = new Map(
      entries.map(([prop, schema]) => [
        prop,
        `--${toFlagName(prop)} <${schema.type ?? "string"}>`,
      ]),
    );
    const width = Math.max(...Array.from(labels.values(), (l) => l.length));
    lines.push("", "Flags:");
    for (const [prop, schema] of entries) {
      const suffix = required.includes(prop) ? " (required)" : "";
      const description = schema.description ?? "";
      lines.push(
        `  ${pad(labels.get(prop)!, width)}   ${description}${suffix}`,
      );
    }
  }

  lines.push("");
  return lines.join("\n");
}

function renderApiHelp(): string {
  return [
    `Usage: ${API_USAGE}`,
    "",
    API_SUMMARY,
    "",
    "Flags:",
    "  --body <json>   Request body, as a JSON string. POST and DELETE only.",
    "",
  ].join("\n");
}

// ── Argument parsing ──

function coerceNumber(value: string, flag: string): number {
  const parsed = Number(value);
  if (value.trim() === "" || Number.isNaN(parsed)) {
    throw new UsageError(`${flag} expects a number, got "${value}".`);
  }
  return parsed;
}

/**
 * Hand-rolled so the CLI carries no dependency. `--flag value` and
 * `--flag=value` are equivalent; booleans take no value and accept a `--no-`
 * form; arrays repeat.
 */
export function parseArgs(
  command: string,
  tool: ToolDef,
  argv: string[],
): Record<string, unknown> {
  const props = properties(tool);
  const propNames = Object.keys(props);

  // Both the kebab form and the raw camelCase form, so args copy-pasted from an
  // MCP call resolve too.
  const byFlag = new Map<string, string>();
  for (const prop of propNames) {
    byFlag.set(toFlagName(prop), prop);
    byFlag.set(prop, prop);
  }
  const validFlags =
    propNames.length > 0
      ? propNames.map((p) => `--${toFlagName(p)}`).join(", ")
      : "(this command takes no flags)";

  const args: Record<string, unknown> = {};

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      throw new UsageError(
        `Unexpected argument "${token}" for ${command}. Valid flags: ${validFlags}`,
      );
    }

    let name = token.slice(2);
    let inline: string | undefined;
    const eq = name.indexOf("=");
    if (eq !== -1) {
      inline = name.slice(eq + 1);
      name = name.slice(0, eq);
    }

    let negated = false;
    let prop = byFlag.get(name);
    if (prop === undefined && name.startsWith("no-")) {
      const candidate = byFlag.get(name.slice(3));
      if (candidate !== undefined && props[candidate].type === "boolean") {
        prop = candidate;
        negated = true;
      }
    }
    if (prop === undefined) {
      throw new UsageError(
        `Unknown flag ${token} for ${command}. Valid flags: ${validFlags}`,
      );
    }

    const schema = props[prop];
    const flag = `--${toFlagName(prop)}`;

    if (schema.type === "boolean") {
      if (inline !== undefined) {
        if (negated || (inline !== "true" && inline !== "false")) {
          throw new UsageError(
            `${flag} is a boolean flag — pass ${flag} or --no-${toFlagName(prop)}, not a value.`,
          );
        }
        args[prop] = inline === "true";
      } else {
        args[prop] = !negated;
      }
      continue;
    }

    const value = inline ?? argv[++i];
    if (value === undefined) {
      throw new UsageError(`${flag} expects a value.`);
    }

    if (schema.type === "number") {
      args[prop] = coerceNumber(value, flag);
    } else if (schema.type === "array") {
      const list = (args[prop] as unknown[] | undefined) ?? [];
      list.push(
        schema.items?.type === "number" ? coerceNumber(value, flag) : value,
      );
      args[prop] = list;
    } else if (schema.type === "object") {
      try {
        args[prop] = JSON.parse(value);
      } catch {
        throw new UsageError(`${flag} expects JSON, got "${value}".`);
      }
    } else {
      args[prop] = value;
    }
  }

  const missing = requiredProps(tool)
    .filter((prop) => args[prop] === undefined)
    .map((prop) => `--${toFlagName(prop)}`);
  if (missing.length > 0) {
    throw new UsageError(
      `Missing required flag${missing.length > 1 ? "s" : ""} for ${command}: ${missing.join(", ")}`,
    );
  }

  return args;
}

// ── Output ──

/**
 * Text goes to stdout verbatim — the same rendering agents see over MCP. Images
 * are written to a temp file and only the path is printed; base64 never hits
 * stdout. (When the caller passed `--path`, the handler already saved the file
 * and returned text, so there is nothing to write here.)
 */
function printResult(result: ToolResult, command: string, io: CliIo): void {
  let imageIndex = 0;
  for (const item of result.content) {
    if (item.type === "text") {
      io.stdout.write(`${item.text ?? ""}\n`);
    } else if (item.type === "image" && item.data) {
      // A single result can carry several images (stop_recording keyframes),
      // so anything past the first gets a suffix rather than the same name.
      const suffix = imageIndex === 0 ? "" : `-${imageIndex}`;
      const file = path.join(
        os.tmpdir(),
        `manor-${command}-${Date.now()}${suffix}.png`,
      );
      fs.writeFileSync(file, Buffer.from(item.data, "base64"));
      io.stdout.write(`Saved ${file}\n`);
      imageIndex++;
    }
  }
}

/** The same message `handleTool` reports for a dead control server. */
function reportError(err: unknown, io: CliIo): number {
  const message = isConnectionError(err)
    ? "Cannot connect to Manor — is it running?"
    : err instanceof HttpError
      ? `HTTP ${err.status}: ${err.rawBody}`
      : err instanceof Error
        ? err.message
        : String(err);
  io.stderr.write(`${message}\n`);
  return 1;
}

// ── The `api` escape hatch ──

const API_METHODS = ["GET", "POST", "DELETE"];

async function runApi(argv: string[], http: Http, io: CliIo): Promise<number> {
  const positional: string[] = [];
  let body: Record<string, unknown> | undefined;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--body" || token.startsWith("--body=")) {
      const raw =
        token === "--body" ? argv[++i] : token.slice("--body=".length);
      if (raw === undefined) throw new UsageError("--body expects a value.");
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        throw new UsageError(`--body expects JSON, got "${raw}".`);
      }
    } else if (token.startsWith("--")) {
      throw new UsageError(
        `Unknown flag ${token} for api. Usage: ${API_USAGE}`,
      );
    } else {
      positional.push(token);
    }
  }

  const [methodArg, urlPath] = positional;
  if (!methodArg || !urlPath) {
    throw new UsageError(`Usage: ${API_USAGE}`);
  }
  const method = methodArg.toUpperCase();
  if (!API_METHODS.includes(method)) {
    throw new UsageError(
      `Unknown method ${methodArg}. Expected one of ${API_METHODS.join(", ")}.`,
    );
  }

  const result =
    method === "GET"
      ? await http.get(urlPath)
      : method === "POST"
        ? await http.post(urlPath, body)
        : await http.del(urlPath, body);

  io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

// ── Entry ──

const HELP_FLAGS = ["--help", "-h"];

export async function runCli(
  argv: string[],
  http: Http,
  io: CliIo,
): Promise<number> {
  const [command, ...rest] = argv;

  if (command === undefined || HELP_FLAGS.includes(command)) {
    io.stdout.write(renderGlobalHelp());
    return 0;
  }

  const wantsHelp = rest.some((arg) => HELP_FLAGS.includes(arg));

  if (command === "api") {
    if (wantsHelp) {
      io.stdout.write(renderApiHelp());
      return 0;
    }
    try {
      return await runApi(rest, http, io);
    } catch (err) {
      if (err instanceof UsageError) {
        io.stderr.write(`${err.message}\n`);
        return 2;
      }
      return reportError(err, io);
    }
  }

  const tool = commands.get(command);
  if (!tool) {
    io.stderr.write(`Unknown command: ${command}. Run manor --help.\n`);
    return 2;
  }

  if (wantsHelp) {
    io.stdout.write(renderCommandHelp(command, tool));
    return 0;
  }

  let args: Record<string, unknown>;
  try {
    args = parseArgs(command, tool, rest);
  } catch (err) {
    if (err instanceof UsageError) {
      io.stderr.write(`${err.message}\n`);
      return 2;
    }
    throw err;
  }

  // Same dispatch as the MCP `handleTool` path.
  const handler = handlers[tool.name];
  if (!handler) {
    io.stderr.write(`No handler for command: ${command}\n`);
    return 2;
  }

  try {
    printResult(await handler(args, http), command, io);
  } catch (err) {
    return reportError(err, io);
  }
  return 0;
}
