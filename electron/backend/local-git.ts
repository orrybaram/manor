import type { GitBackend, WorktreeInfo } from "./types";

export class LocalGitBackend implements GitBackend {
  async exec(_cwd: string, _args: string[]): Promise<string> {
    throw new Error("Not implemented");
  }

  async stage(_cwd: string, _files: string[]): Promise<void> {
    throw new Error("Not implemented");
  }

  async unstage(_cwd: string, _files: string[]): Promise<void> {
    throw new Error("Not implemented");
  }

  async discard(_cwd: string, _files: string[]): Promise<void> {
    throw new Error("Not implemented");
  }

  async commit(
    _cwd: string,
    _message: string,
    _flags: string[],
  ): Promise<void> {
    throw new Error("Not implemented");
  }

  async stash(_cwd: string, _files: string[]): Promise<void> {
    throw new Error("Not implemented");
  }

  async getFullDiff(
    _cwd: string,
    _defaultBranch: string,
  ): Promise<string | null> {
    throw new Error("Not implemented");
  }

  async getLocalDiff(_cwd: string): Promise<string | null> {
    throw new Error("Not implemented");
  }

  async getStagedFiles(_cwd: string): Promise<string[]> {
    throw new Error("Not implemented");
  }

  async worktreeList(_cwd: string): Promise<WorktreeInfo[]> {
    throw new Error("Not implemented");
  }

  async worktreeAdd(
    _cwd: string,
    _path: string,
    _branch: string,
    _opts?: { createBranch?: boolean; startPoint?: string },
  ): Promise<void> {
    throw new Error("Not implemented");
  }

  async worktreeRemove(
    _cwd: string,
    _path: string,
    _force?: boolean,
  ): Promise<void> {
    throw new Error("Not implemented");
  }
}
