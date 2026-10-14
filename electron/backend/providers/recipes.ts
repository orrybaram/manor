/**
 * Host recipes (ADR-229 D2): the user's own commands that start, stop and
 * delete one host, and the strict shapes of what they say back.
 *
 * - **Where.** `~/.manor/host-recipes/<recipeId>/recipe.json`, next to its
 *   scripts (`hostRecipesDir()`). Never read from a project or a repository:
 *   cloning a repo must not be able to run code on this machine.
 * - **One recipe, one host.** The recipe's `state.json` is its scripts';
 *   Manor's own record of the host (`host.json`: the last `up`'s `resource`,
 *   whether it was last put to sleep) sits beside it.
 * - **Strict.** `recipe.json`, `up`'s result and `status`'s result refuse
 *   unknown keys, as Orca's recipes do: a typo is an error, not a silently
 *   ignored setting.
 *
 * No process is spawned here; `recipe-runner.ts` runs the commands.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { hostRecipesDir } from "../../paths";
import type { HostSpec } from "../types";

// ── recipe.json ──

/** The commands a recipe may declare. Only `up` is required. */
export type RecipeCommandName = "up" | "status" | "stop" | "destroy";

export interface Recipe {
  schemaVersion: 1;
  /** Its directory's name under `hostRecipesDir()`. */
  id: string;
  /** How the host is named: in the sidebar, in messages. */
  name: string;
  /** The bundled template it was made from (ADR-229 D8), if any. */
  template?: string;
  /** Creates the box if missing, resumes it if stopped; prints a way in. */
  up: string;
  status?: string;
  stop?: string;
  destroy?: string;
  /** Stop the box after this long idle, while this desktop is awake (D7). */
  idleStopMinutes?: number;
  /** Non-secret parameters, added to each command's environment. */
  env?: Record<string, string>;
}

/** A recipe id: a directory name, and nothing a path could escape with. */
const RECIPE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RECIPE_KEYS: ReadonlySet<string> = new Set([
  "schemaVersion",
  "id",
  "name",
  "template",
  "up",
  "status",
  "stop",
  "destroy",
  "idleStopMinutes",
  "env",
]);

/** A recipe, or its command's output, that does not have the agreed shape. */
export class RecipeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecipeError";
  }
}

/** Throws unless `id` can name a recipe directory. */
export function assertRecipeId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !RECIPE_ID.test(id) || id === "." || id === "..") {
    throw new RecipeError(`Invalid recipe id: ${JSON.stringify(id)}`);
  }
}

/** `<baseDir>/<id>`: the recipe's directory, its commands' cwd. */
export function recipeDir(id: string, baseDir: string = hostRecipesDir()): string {
  assertRecipeId(id);
  return path.join(baseDir, id);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Refuse any key of `obj` that `allowed` does not name. */
function refuseUnknownKeys(obj: Record<string, unknown>, allowed: ReadonlySet<string>, what: string): void {
  const unknown = Object.keys(obj).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new RecipeError(`${what} has unknown ${unknown.length === 1 ? "key" : "keys"}: ${unknown.join(", ")}`);
  }
}

function optionalString(obj: Record<string, unknown>, key: string, what: string): string | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new RecipeError(`${what}.${key} must be a non-empty string`);
  }
  return value;
}

/**
 * A recipe command's path, resolved: an absolute path as given, a relative
 * one inside `dir`. One that climbs out of `dir` is refused — the recipe's
 * directory is the only place a relative command may come from.
 */
export function resolveRecipeCommand(dir: string, command: string): string {
  if (command.includes("\0") || /[\r\n]/.test(command)) {
    throw new RecipeError(`Invalid recipe command: ${JSON.stringify(command)}`);
  }
  if (path.isAbsolute(command)) return path.normalize(command);
  const resolved = path.resolve(dir, command);
  const rel = path.relative(dir, resolved);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new RecipeError(
      `Recipe command ${JSON.stringify(command)} must be an absolute path or inside the recipe's directory`,
    );
  }
  return resolved;
}

/**
 * Validate a parsed `recipe.json` strictly (ADR-229 D2). `dir` is where it
 * was read from: its name must be the recipe's `id`, and every relative
 * command must resolve inside it.
 */
export function parseRecipe(value: unknown, dir: string): Recipe {
  const what = "recipe.json";
  if (!isPlainObject(value)) throw new RecipeError(`${what} must be a JSON object`);
  refuseUnknownKeys(value, RECIPE_KEYS, what);
  if (value.schemaVersion !== 1) {
    throw new RecipeError(`${what}.schemaVersion must be 1, not ${JSON.stringify(value.schemaVersion)}`);
  }
  assertRecipeId(value.id);
  if (value.id !== path.basename(dir)) {
    throw new RecipeError(`${what}.id ${JSON.stringify(value.id)} doesn't match its directory ${JSON.stringify(path.basename(dir))}`);
  }
  const name = optionalString(value, "name", what);
  if (name === undefined) throw new RecipeError(`${what}.name is required`);
  const up = optionalString(value, "up", what);
  if (up === undefined) throw new RecipeError(`${what}.up is required`);
  const recipe: Recipe = { schemaVersion: 1, id: value.id, name: name.trim(), up };
  const template = optionalString(value, "template", what);
  if (template !== undefined) recipe.template = template;
  for (const key of ["status", "stop", "destroy"] as const) {
    const command = optionalString(value, key, what);
    if (command !== undefined) recipe[key] = command;
  }
  for (const key of ["up", "status", "stop", "destroy"] as const) {
    const command = recipe[key];
    if (command !== undefined) resolveRecipeCommand(dir, command);
  }
  const idle = value.idleStopMinutes;
  if (idle !== undefined) {
    if (typeof idle !== "number" || !Number.isInteger(idle) || idle <= 0) {
      throw new RecipeError(`${what}.idleStopMinutes must be a positive whole number`);
    }
    recipe.idleStopMinutes = idle;
  }
  const env = value.env;
  if (env !== undefined) {
    if (!isPlainObject(env)) throw new RecipeError(`${what}.env must be an object of strings`);
    const out: Record<string, string> = {};
    for (const [key, val] of Object.entries(env)) {
      if (!ENV_NAME.test(key)) throw new RecipeError(`${what}.env has an invalid name: ${JSON.stringify(key)}`);
      if (typeof val !== "string") throw new RecipeError(`${what}.env.${key} must be a string`);
      out[key] = val;
    }
    recipe.env = out;
  }
  return recipe;
}

/** Names read back from `recipe.json`, for labels: `hostSpecLabel` reads this. */
const recipeNames = new Map<string, string>();

/** Read and validate `<baseDir>/<id>/recipe.json`. Throws a `RecipeError` saying what is wrong. */
export function readRecipe(id: string, baseDir: string = hostRecipesDir()): Recipe {
  const dir = recipeDir(id, baseDir);
  const file = path.join(dir, "recipe.json");
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new RecipeError(
      code === "ENOENT" ? `No recipe "${id}" in ${baseDir}` : `Could not read ${file}: ${String(err)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new RecipeError(`${file} is not valid JSON: ${(err as Error).message}`);
  }
  const recipe = parseRecipe(parsed, dir);
  if (baseDir === hostRecipesDir()) recipeNames.set(id, recipe.name);
  return recipe;
}

/**
 * Write `recipe` as `<baseDir>/<id>/recipe.json`, creating the directory.
 * Validated first, as it will be read back.
 */
export function writeRecipe(recipe: Recipe, baseDir: string = hostRecipesDir()): void {
  const dir = recipeDir(recipe.id, baseDir);
  const valid = parseRecipe(recipe, dir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "recipe.json");
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(valid, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  if (baseDir === hostRecipesDir()) recipeNames.set(recipe.id, valid.name);
}

/**
 * How the user names a host with `spec`: an ssh box's target, a recipe
 * host's recipe name (read once, then remembered) — or its recipe id when
 * the recipe can't be read.
 */
export function hostSpecLabel(spec: HostSpec): string {
  if (spec.kind === "ssh") return spec.target;
  const known = recipeNames.get(spec.recipeId);
  if (known !== undefined) return known;
  try {
    return readRecipe(spec.recipeId).name;
  } catch {
    return spec.recipeId;
  }
}

// ── Command results ──

/** How `up` says to reach the box over ssh (ADR-229 D2). */
export interface RecipeSshTarget {
  host: string;
  port: number;
  username: string;
  identityFile?: string;
  identitiesOnly?: boolean;
  jumpHost?: string;
  proxyCommand?: string;
  /** The box's public host key, `<type> <base64>`: trusted for this host alone. */
  hostKey?: string;
}

export type RecipeConnection =
  | { type: "ssh"; target: RecipeSshTarget }
  /** An argv prefix that runs one command on the box with stdio attached (D3). */
  | { type: "exec"; argv: string[] };

export interface RecipeUpResult {
  schemaVersion: 1;
  /** Opaque to Manor; handed back on every command's stdin. */
  resource?: unknown;
  connection: RecipeConnection;
  /** The provider puts the box to sleep by itself when idle. */
  autoSleep?: boolean;
}

export type RecipeStatusState = "up" | "sleeping" | "missing" | "error";

export interface RecipeStatusResult {
  state: RecipeStatusState;
  detail?: string;
}

const UP_KEYS: ReadonlySet<string> = new Set(["schemaVersion", "resource", "connection", "autoSleep"]);
const SSH_CONNECTION_KEYS: ReadonlySet<string> = new Set(["type", "target"]);
const EXEC_CONNECTION_KEYS: ReadonlySet<string> = new Set(["type", "argv"]);
const SSH_TARGET_KEYS: ReadonlySet<string> = new Set([
  "host",
  "port",
  "username",
  "identityFile",
  "identitiesOnly",
  "jumpHost",
  "proxyCommand",
  "hostKey",
]);
const STATUS_KEYS: ReadonlySet<string> = new Set(["state", "detail"]);
const STATUS_STATES: ReadonlySet<string> = new Set(["up", "sleeping", "missing", "error"]);

/** A host name or address ssh can take as `HostName`: no spaces, quotes or options. */
const SSH_HOST = /^(?:[A-Za-z0-9._%-]+|\[[0-9A-Fa-f:.%]+\]|[0-9A-Fa-f:.%]+)$/;
const SSH_USER = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;
/** `ProxyJump`: `[user@]host[:port]`, comma-separated. */
const SSH_JUMP = /^[A-Za-z0-9._@:[\]%,-]+$/;
/** `<type> <base64>`, an optional comment ignored. */
const HOST_KEY = /^([a-z0-9@.-]+) ([A-Za-z0-9+/]+={0,3})(?: [^\r\n]*)?$/;

function parseSshTarget(value: unknown): RecipeSshTarget {
  const what = "up's connection.target";
  if (!isPlainObject(value)) throw new RecipeError(`${what} must be an object`);
  refuseUnknownKeys(value, SSH_TARGET_KEYS, what);
  const { host, port, username } = value;
  if (typeof host !== "string" || !SSH_HOST.test(host) || host.startsWith("-")) {
    throw new RecipeError(`${what}.host is not a host name or address: ${JSON.stringify(host)}`);
  }
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RecipeError(`${what}.port must be a port number, not ${JSON.stringify(port)}`);
  }
  if (typeof username !== "string" || !SSH_USER.test(username)) {
    throw new RecipeError(`${what}.username is not a user name: ${JSON.stringify(username)}`);
  }
  const target: RecipeSshTarget = { host: host.replace(/^\[|\]$/g, ""), port, username };
  if (value.identityFile !== undefined) {
    const file = value.identityFile;
    if (typeof file !== "string" || file === "" || /["\r\n\0]/.test(file)) {
      throw new RecipeError(`${what}.identityFile must be a path without quotes or newlines`);
    }
    target.identityFile = file;
  }
  if (value.identitiesOnly !== undefined) {
    if (typeof value.identitiesOnly !== "boolean") {
      throw new RecipeError(`${what}.identitiesOnly must be true or false`);
    }
    target.identitiesOnly = value.identitiesOnly;
  }
  if (value.jumpHost !== undefined && value.proxyCommand !== undefined) {
    throw new RecipeError(`${what} can't have both jumpHost and proxyCommand`);
  }
  if (value.jumpHost !== undefined) {
    const jump = value.jumpHost;
    if (typeof jump !== "string" || !SSH_JUMP.test(jump) || jump.startsWith("-")) {
      throw new RecipeError(`${what}.jumpHost is not a [user@]host[:port] list: ${JSON.stringify(jump)}`);
    }
    target.jumpHost = jump;
  }
  if (value.proxyCommand !== undefined) {
    const proxy = value.proxyCommand;
    if (typeof proxy !== "string" || proxy.trim() === "" || /[\r\n\0]/.test(proxy)) {
      throw new RecipeError(`${what}.proxyCommand must be one line`);
    }
    target.proxyCommand = proxy.trim();
  }
  if (value.hostKey !== undefined) {
    const key = value.hostKey;
    const match = typeof key === "string" ? HOST_KEY.exec(key.trim()) : null;
    if (!match) {
      throw new RecipeError(`${what}.hostKey must be "<type> <base64 key>", as in known_hosts`);
    }
    target.hostKey = `${match[1]} ${match[2]}`;
  }
  return target;
}

function parseConnection(value: unknown): RecipeConnection {
  const what = "up's connection";
  if (!isPlainObject(value)) throw new RecipeError(`${what} must be an object`);
  if (value.type === "ssh") {
    refuseUnknownKeys(value, SSH_CONNECTION_KEYS, what);
    return { type: "ssh", target: parseSshTarget(value.target) };
  }
  if (value.type === "exec") {
    refuseUnknownKeys(value, EXEC_CONNECTION_KEYS, what);
    const { argv } = value;
    if (
      !Array.isArray(argv) ||
      argv.length === 0 ||
      !argv.every((arg): arg is string => typeof arg === "string") ||
      argv[0] === ""
    ) {
      throw new RecipeError(`${what}.argv must be a non-empty array of strings`);
    }
    return { type: "exec", argv: [...argv] };
  }
  throw new RecipeError(`${what}.type must be "ssh" or "exec", not ${JSON.stringify(value.type)}`);
}

/** Validate what `up` printed (ADR-229 D2). */
export function parseUpResult(value: unknown): RecipeUpResult {
  const what = "up's result";
  if (!isPlainObject(value)) throw new RecipeError(`${what} must be a JSON object`);
  refuseUnknownKeys(value, UP_KEYS, what);
  if (value.schemaVersion !== 1) {
    throw new RecipeError(`${what}.schemaVersion must be 1, not ${JSON.stringify(value.schemaVersion)}`);
  }
  const result: RecipeUpResult = { schemaVersion: 1, connection: parseConnection(value.connection) };
  if (value.resource !== undefined) result.resource = value.resource;
  if (value.autoSleep !== undefined) {
    if (typeof value.autoSleep !== "boolean") throw new RecipeError(`${what}.autoSleep must be true or false`);
    result.autoSleep = value.autoSleep;
  }
  return result;
}

/** Validate what `status` printed (ADR-229 D2). */
export function parseStatusResult(value: unknown): RecipeStatusResult {
  const what = "status's result";
  if (!isPlainObject(value)) throw new RecipeError(`${what} must be a JSON object`);
  refuseUnknownKeys(value, STATUS_KEYS, what);
  if (typeof value.state !== "string" || !STATUS_STATES.has(value.state)) {
    throw new RecipeError(`${what}.state must be up, sleeping, missing or error, not ${JSON.stringify(value.state)}`);
  }
  const result: RecipeStatusResult = { state: value.state as RecipeStatusState };
  if (value.detail !== undefined) {
    if (typeof value.detail !== "string") throw new RecipeError(`${what}.detail must be a string`);
    result.detail = value.detail;
  }
  return result;
}

// ── Manor's record of the host ──

/**
 * What Manor remembers of its recipe's host between runs, in `host.json`
 * beside `recipe.json`: what the last `up` returned as `resource` (handed
 * back on every command's stdin), and whether the box was last put to sleep
 * — the state a recipe without `status` reports.
 */
export interface RecipeHostState {
  /** The host this record is for; a record for another is ignored. */
  hostId: string;
  resource?: unknown;
  autoSleep?: boolean;
  /** How Manor last left the box. */
  last: "up" | "sleeping";
}

const HOST_STATE_FILE = "host.json";

/** `dir`'s record for `hostId`, or null when it has none (or one for another host). */
export function readRecipeHostState(dir: string, hostId: string): RecipeHostState | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(dir, HOST_STATE_FILE), "utf-8"));
    if (!isPlainObject(parsed) || parsed.hostId !== hostId) return null;
    return {
      hostId,
      ...(parsed.resource !== undefined ? { resource: parsed.resource } : {}),
      ...(typeof parsed.autoSleep === "boolean" ? { autoSleep: parsed.autoSleep } : {}),
      last: parsed.last === "sleeping" ? "sleeping" : "up",
    };
  } catch {
    return null;
  }
}

/** Save `state` as `dir`'s record. Best effort: a failed write is logged, not thrown. */
export function writeRecipeHostState(dir: string, state: RecipeHostState): void {
  const file = path.join(dir, HOST_STATE_FILE);
  try {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    console.warn(`[recipes] could not save ${file}:`, err);
  }
}

/**
 * Drop `dir`'s record when it is `hostId`'s: the host was removed from Manor
 * but its box was kept (ADR-229 D8), so a host added from the recipe later
 * starts with no `resource` of its predecessor's. Best effort.
 */
export function forgetRecipeHostState(dir: string, hostId: string): void {
  if (readRecipeHostState(dir, hostId) === null) return;
  try {
    fs.rmSync(path.join(dir, HOST_STATE_FILE), { force: true });
  } catch (err) {
    console.warn(`[recipes] could not remove ${dir}'s ${HOST_STATE_FILE}:`, err);
  }
}
