## ADR Workflow
When an ADR is required is defined in `.claude/rules/adr-workflow.md`; the steps live in the `adr-workflow` skill.

## Agents
Agent definitions in `.claude/agents/` are registered agent types. Spawn them with `subagent_type` (`implementer`, `verifier`, `code-reviewer`); their definitions load automatically.

## Discovering More
Skills: `.claude/skills/`
Rules: `.claude/rules/`
Agents: `.claude/agents/`
Decisions: `docs/decisions/`
