/**
 * The Home surface (the Dashboard) keys a `WorkspaceLayout` in `app-store`
 * like a real project workspace path — layout keying accepts opaque strings —
 * but it has no owning project and never holds tabs.
 *
 * `HOME_PATH` / `isHomePath` live in the import-free `home-path` leaf module so
 * the Electron main process can import them; they are re-exported here so
 * renderer code has one place to import all home helpers from.
 */
export { HOME_PATH, isHomePath } from "./home-path";
