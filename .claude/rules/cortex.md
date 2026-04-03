## Required: ADR Workflow
Before implementing ANY code change, read and follow the skill at:
`.claude/skills/adr-workflow/SKILL.md`

Do NOT use `EnterPlanMode`. The ADR replaces plan mode entirely.

Exceptions (no ADR needed):
- Pure research/exploration
- Discussing or modifying rules/skills

## Agent Definitions
When spawning implementation agents, read the agent definition and include
its content in the agent prompt:
- Implementer: `.claude/agents/implementer.md`
- Verifier: `.claude/agents/verifier.md`

## Discovering More
Skills: `.claude/skills/`
Rules: `.claude/rules/`
Agents: `.claude/agents/`
Decisions: `docs/decisions/`
