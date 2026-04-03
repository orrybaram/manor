---
name: adr-workflow
description: "ADR-driven development workflow"
disable-model-invocation: false
---

# ADR-Driven Development

Every task gets an ADR before any code changes. This creates an observability layer where every decision, change, and tradeoff is recorded.

**Do NOT use `EnterPlanMode`.** The ADR replaces plan mode entirely.

## Overview

ADRs live in `docs/decisions/` alongside the project's docs. Implementation code lives in the repo. The ADR captures *why* and *what*; the code captures *how*.

```
docs/
  decisions/
    adr-001-add-auth/
      index.md                    # The decision record
      ticket-1-add-routes.md      # Implementation tickets
      ticket-2-add-middleware.md

src/
  auth/                           # Implementation lives here
```

## Step 1: Resolve decisions path

The decisions directory is `docs/decisions/`. Create it if it doesn't exist.

## Step 2: Determine ADR number

Scan for existing `adr-NNN-*` folders. The next number is `max(existing) + 1`, zero-padded to 3 digits. Start at `001` if none exist.

Choose a short slug: `adr-003-add-search-api`.

Also ensure `docs/decisions/index.md` has a database schema. Read the file if it exists; if it already contains `database:` in its frontmatter, leave it unchanged. Otherwise create or overwrite it with:

```markdown
---
title: Decisions
database:
  schema:
    status:
      type: select
      options: [proposed, accepted, superseded]
      default: proposed
  defaultView: list
---

# Decisions

All architecture decisions for this project.

<div data-type="database" data-path="." data-view="list"></div>
```

## Step 3: Create ADR skeleton

Create directory `docs/decisions/adr-NNN-slug/` and write `index.md`:

```markdown
---
type: adr
status: proposed
database:
  schema:
    status:
      type: select
      options: [todo, in-progress, review, done]
      default: todo
    priority:
      type: select
      options: [critical, high, medium, low]
    assignee:
      type: select
      options: [opus, sonnet, haiku]
  defaultView: board
  groupBy: status
---

# ADR-NNN: Title

## Context

## Decision

## Consequences

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
```

The `database` frontmatter and `data-path="."` div allow rendering the ticket files as a kanban board.

## Step 4: Research

Before writing the ADR, explore the codebase:
- Understand existing patterns and architecture
- Identify files that need changes
- Find existing functions and utilities to reuse
- Consider multiple approaches and their tradeoffs

Use Explore agents for broad codebase research. Use Grep/Glob for targeted searches.

## Step 5: Write the ADR

Fill in `index.md`. **Do NOT leave sections as placeholders.**

- **Context**: The problem, background, what prompted this. Why does this change need to happen?
- **Decision**: The approach. Be specific — name files, patterns, APIs, libraries.
- **Consequences**: Tradeoffs. What gets better, what gets harder, what risks exist.

## Step 6: Create tickets

Create one `.md` file per implementation step in the ADR folder.

**Filename**: `ticket-N-short-slug.md`

**Format**:
```markdown
---
title: Short descriptive title
status: todo
priority: critical|high|medium|low
assignee: opus|sonnet|haiku
blocked_by: []
---

# Title

Implementation instructions with enough detail for the assigned model to work independently.

## Files to touch
- `src/path/to/file.ts` — what to change and why
```

**`blocked_by`**: List ticket numbers (e.g. `[1, 3]`) that must complete before this ticket can start. Leave empty `[]` or omit for tickets with no dependencies.

When creating tickets, explicitly set `blocked_by` based on logical dependencies (e.g., a ticket that wires components depends on the ticket that creates them).

**Assignee = model selection:**
- **haiku** — mechanical: renames, config, imports, straightforward tests
- **sonnet** — moderate: single-file features, bug fixes, CRUD, wiring patterns
- **opus** — complex: multi-file architecture, new abstractions, cross-cutting concerns

## Step 7: Ask for approval
Show the full overview of the ticket as well as a file system link to the location of the ADR


Use `AskUserQuestion` to present the ADR. Include:
- One-sentence summary of the decision
- Number of tickets and their model assignments
- The ADR folder path so the user can review

**Do NOT write implementation code until the user approves.**

## Step 8: Execute

After approval:

### 8a. Read and resolve dependencies

1. Read all ticket files from the ADR folder
2. Parse `blocked_by` from each ticket's frontmatter
3. Compute file overlaps: compare "Files to touch" across tickets. If ticket B's files overlap with ticket A's and there's no explicit `blocked_by`, add an implicit dependency (B waits for A, lower ticket number first)
4. Build a dependency graph: ticket → [tickets it's blocked by]

### 8b. Classify tickets: parallel vs sequential

Using the dependency graph from 8a, classify tickets into two groups:

- **Parallel tickets**: No `blocked_by` AND no file overlaps with other ready tickets. These can run concurrently in worktrees.
- **Sequential tickets**: Have `blocked_by` dependencies OR file overlaps with other tickets. These MUST run one at a time on main, each building on the previous commit.

**Important**: Most ADRs have a dependency chain (ticket 2 depends on 1, ticket 3 depends on 2). In this common case, ALL tickets are sequential — do NOT use worktrees.

### 8c. Execute parallel tickets (if any)

For each parallel ticket with no dependencies:

- Spawn via `Agent` tool:
  - `model` based on the ticket's `assignee` field (haiku/sonnet/opus)
  - `isolation: "worktree"` — each agent gets its own branch
  - `run_in_background: true`
  - `mode: "bypassPermissions"`
  - Prompt includes the compact prime (see 8e below)
- Update ticket frontmatter: `status: todo` → `status: in-progress`
- When complete: verify (see 8f), then merge worktree branch into main

### 8d. Execute sequential tickets (in order)

For each sequential ticket, **one at a time**, in dependency order:

- Spawn via `Agent` tool:
  - `model` based on the ticket's `assignee` field (haiku/sonnet/opus)
  - **No `isolation`** — runs directly on main so it sees all prior ticket commits
  - `run_in_background: true`
  - `mode: "bypassPermissions"`
  - Prompt includes the compact prime (see 8e below)
- Update ticket frontmatter: `status: todo` → `status: in-progress`
- **Wait for completion and verification before spawning the next ticket**

### 8e. Agent prompt format

Every agent prompt includes:
- ADR number and title (one line)
- How many tickets total, which are done/blocked/ready
- The full ticket content for THIS ticket
- The "Files to touch" section
- **MANDATORY — include verbatim at the end of every agent prompt:**
  ```
  ## REQUIRED: Commit your work

  When your implementation is complete, you MUST create a git commit. This is not optional.

  Run:
    git add -A
    git commit -m "feat(adr-NNN): <ticket title>"

  Replace NNN with the ADR number and use the exact ticket title as the commit message body.
  Do not push.
  ```

### 8f. Per-ticket verification (after each agent completes)

1. If the agent used a worktree, get the worktree path; otherwise it committed to main directly
2. Spawn a **verifier agent** (haiku):
   - `mode: "bypassPermissions"`
   - If worktree: set working directory to the worktree path
   - If main: no special setup needed
   - Prompt: run typecheck and build verification
3. **PASS** → update ticket `status: done`. If worktree, merge branch into main. Then check if downstream tickets are now unblocked.
4. **FAIL** → re-spawn the implementation agent (resume via agent ID if possible) with error output. Retry up to 2 times, then escalate.

### 8g. Integration verification (after all tickets done)

1. Spawn a **verifier agent** on main branch (no isolation)
2. **PASS** → update ADR `index.md`: `status: proposed` → `status: accepted`
3. **FAIL** → create follow-up `ticket-N-fix-integration.md`, spawn agent, re-verify

**Important**: Agents write implementation code to the **repo** (the working directory). ADR files live in `docs/decisions/`. Only the main session writes to the decisions directory — agents don't need decisions access.
