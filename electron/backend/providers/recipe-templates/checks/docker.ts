/**
 * The `docker` template's checks (ADR-234 D6). For now only its choices:
 * the daemon's contexts, from `docker context ls`. A missing CLI or a
 * failing command lists none.
 */

import type { Choice, TemplateCheckResult } from "../types";
import type { CheckDeps } from "./deps";

interface DockerContextRow {
  Name?: unknown;
  Current?: unknown;
  DockerEndpoint?: unknown;
  Description?: unknown;
}

/**
 * `docker context ls --format '{{json .}}'`: one JSON object per line on
 * most versions, a single array on some. Rows without a name are skipped.
 */
export function parseDockerContexts(stdout: string): Choice[] {
  const trimmed = stdout.trim();
  if (trimmed === "") return [];
  let rows: unknown[];
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      rows = Array.isArray(parsed) ? parsed : [];
    } catch {
      rows = [];
    }
  } else {
    rows = trimmed.split(/\r?\n/).flatMap((line) => {
      try {
        return [JSON.parse(line) as unknown];
      } catch {
        return [];
      }
    });
  }
  return rows.flatMap((row): Choice[] => {
    if (typeof row !== "object" || row === null) return [];
    const { Name, Current, DockerEndpoint } = row as DockerContextRow;
    if (typeof Name !== "string" || Name === "") return [];
    const current = Current === true || Current === "true";
    return [
      {
        value: Name,
        label: current ? `${Name} · Docker's current` : Name,
        ...(typeof DockerEndpoint === "string" && DockerEndpoint !== ""
          ? { hint: DockerEndpoint }
          : {}),
      },
    ];
  });
}

async function dockerContexts(deps: CheckDeps): Promise<Choice[]> {
  try {
    return parseDockerContexts(
      await deps.execFile("docker", ["context", "ls", "--format", "{{json .}}"]),
    );
  } catch {
    return [];
  }
}

export async function check(
  _values: Record<string, string>,
  deps: CheckDeps,
): Promise<TemplateCheckResult> {
  return { checks: [], choices: { context: await dockerContexts(deps) } };
}
