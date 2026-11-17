import { createContext } from "react";
import type { HostId } from "../../../lib/workspace-key";

/**
 * The host the chat's pane runs on, for what the chat reads from its disk
 * (a pasted image). Null where the chat doesn't know its workspace.
 */
export const ChatHostContext = createContext<HostId | null>(null);
