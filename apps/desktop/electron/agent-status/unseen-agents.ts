/**
 * Which agents the user has not looked at since they responded or asked for
 * input.
 *
 * One of these per server, owned by whoever composes it and
 * shared by the status pipeline that writes it, the handlers that clear it
 * and the broadcast that ships it, so the answer to "is this agent unseen?"
 * has one home. Electron-free: the host server uses it too.
 */

/**
 * Per-agent unseen flags as broadcast to the renderer alongside `agent-updated`.
 *
 * The renderer keeps two Sets (`unseenRespondedAgentIds`, `unseenInputAgentIds`)
 * as a *cache* of these flags. Always derive the flags from the server's Sets
 * at the moment of the broadcast so the renderer never drifts.
 */
export type AgentUnseenFlags = {
  responded: boolean;
  requires_input: boolean;
};

export class UnseenAgents {
  readonly responded = new Set<string>();
  readonly requiresInput = new Set<string>();

  flagsFor(agentId: string): AgentUnseenFlags {
    return {
      responded: this.responded.has(agentId),
      requires_input: this.requiresInput.has(agentId),
    };
  }

  /** Mark `agentId` seen. Returns whether either flag was set. */
  clear(agentId: string): boolean {
    const responded = this.responded.delete(agentId);
    const requiresInput = this.requiresInput.delete(agentId);
    return responded || requiresInput;
  }
}
