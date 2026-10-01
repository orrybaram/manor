/**
 * Projects and their persistence now live in `electron/projects/` (ADR-183);
 * this re-exports their public surface for existing importers.
 */

export { ProjectManager } from "./projects/project-manager";
export {
  normalizeSidebarOrder,
  spliceFolderOut,
  isFolderDescendant,
} from "./projects/workspace-folders";
export {
  validateRepoUrl,
  validateRemoteDir,
  normalizeOriginUrl,
} from "./projects/remote-clone";
export type {
  CreateWorktreeOptions,
  CustomCommand,
  FolderLink,
  GroupUpdatableFields,
  IssueSeed,
  LinkedIssue,
  ProjectHost,
  ProjectGroupInfo,
  ProjectHostResolver,
  ProjectInfo,
  ProjectUpdatableFields,
  WorkspaceFolder,
  WorkspaceFromIssue,
  WorkspaceInfo,
} from "./projects/types";
