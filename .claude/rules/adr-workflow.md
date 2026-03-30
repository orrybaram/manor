---
name: adr-workflow
---

Before implementing ANY LARGE FEATURE code change, you MUST call the Skill tool with `skill: "adr-workflow"`. DO NOT CALL this for smaller UI or UX tweaks. This is the ONLY way to start the ADR process — do NOT manually execute the skill's steps (resolving paths, creating directories, writing markdown files, etc.). The Skill tool loads the full instructions; follow them after it loads.

Do NOT use `EnterPlanMode`. The ADR replaces plan mode entirely.

Exceptions (no ADR needed):
- Pure research/exploration (reading files, answering questions)
- Discussing or modifying this rule itself
