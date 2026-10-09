/**
 * The `POST /jev/folder` contract (ADR-211), shared by the desktop that
 * builds the request (`electron/folder-suggestion.ts`, `electron/jev.ts`) and
 * the relay worker that checks it (`relay/src/jev.ts`). A limit changed here
 * changes on both sides, so the desktop never sends what the worker refuses.
 */

/** The worker refuses a larger request body with 413. */
export const JEV_MAX_BODY_BYTES = 16 * 1024;
export const JEV_MIN_OPTIONS = 2;
export const JEV_MAX_OPTIONS = 64;
/** Option keys are folder ids (UUIDs) or `__none__`. */
export const JEV_OPTION_KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const JEV_MAX_OPTION_CHARS = 400;
/** The `state` fields the worker accepts, and each one's maximum length. */
export const JEV_STATE_MAX_CHARS = {
  workspaceName: 200,
  branchName: 200,
  agentPrompt: 2000,
} as const;

export type JevStateField = keyof typeof JEV_STATE_MAX_CHARS;

/**
 * The signed data of a request. Absent `state` fields are omitted, never
 * `undefined`: the signature covers the canonical JSON of this object.
 */
export interface JevPayload {
  state: Partial<Record<JevStateField, string>> & { workspaceName: string };
  /** Option key -> description. */
  options: Record<string, string>;
}

/** The worker's reply to a request it served. */
export interface JevAnswer {
  choice: string;
  confidence: number;
}

/** A folder Jev picked for a new workspace, with how sure it was. */
export interface FolderPick {
  folderId: string;
  confidence: number;
}
