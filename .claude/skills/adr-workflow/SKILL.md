---
name: adr-workflow
description: "Use before implementing a large feature: research, write an ADR with tickets, get approval through a plain-language artifact, then execute the tickets with subagents, review, and fix."
disable-model-invocation: false
---

# ADR-Driven Development

A large feature gets an ADR before any code changes. The ADR records *why* and *what*; the code records *how*. Only this session writes to `docs/decisions/`; subagents write code.

```
docs/decisions/
  index.md                      # database view of all ADRs
  adr-235-pod-per-project/
    index.md                    # the decision record
    ticket-1-add-routes.md      # implementation tickets
    ticket-2-add-middleware.md
```

"The branch" below means the branch this session is on (normally a `feat/adr-NNN-*` branch), never `main`.

## Step 1: Number and skeleton

The next number is the highest `adr-NNN-*` folder in `docs/decisions/` plus one, zero-padded to 3 digits. Pick a short slug: `adr-236-add-search-api`.

`docs/decisions/index.md` already exists with its database view; leave it alone. (Only if it is missing, create it with `title: Decisions` and a `database.schema.status` select of `[proposed, accepted, superseded]`.)

Create `docs/decisions/adr-NNN-slug/index.md`:

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

The `database` frontmatter and the `data-path="."` div render the ticket files as a kanban board.

## Step 2: Research

Follow `docs/agents/domain.md`: read `CONTEXT.md` and the ADRs that touch this area, use the glossary's terms, and flag any conflict with an existing ADR in the Decision section.

Then explore the code: existing patterns, the files that need changes, utilities to reuse. Use Explore agents for broad sweeps, Grep/Glob for targeted lookups.

Architecture and planning run on Fable. Spawn a `Plan` agent with `model: "fable"`, give it the request and your research findings, and have it weigh at least two approaches, pick one, and break it into tickets with dependencies. Steps 3 and 4 write up its plan; disagree with it only with a reason you state to the user.

Research is done when the plan names every file the change touches.

## Step 3: Write the ADR

Fill every section of `index.md`:

- **Context**: the problem and what prompted it.
- **Decision**: the approach, specific: files, patterns, APIs, libraries. Note rejected approaches and why.
- **Consequences**: what gets better, what gets harder, what could go wrong.

## Step 4: Create tickets

One file per implementation step, `ticket-N-short-slug.md`:

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

Set `blocked_by` to the ticket numbers that must land first (e.g. a ticket that wires components is blocked by the ticket that creates them); `[]` when none.

**Assignee is the model the ticket runs on:**
- **haiku**: mechanical: renames, config, imports, straightforward tests
- **sonnet**: moderate: single-file features, bug fixes, CRUD, wiring existing patterns
- **opus**: complex: multi-file changes, new abstractions, cross-cutting concerns

Fable plans (Step 2); it never executes a ticket.

## Step 5: Explain it in an artifact

Publish an artifact (Artifact tool; it requires loading `artifact-design` first) that explains the ADR in the simplest terms, for someone who has not read the code:

- **The problem**, in two or three plain sentences.
- **What we'll do**, as a short story of the change, with no file paths and no jargon. Use the `CONTEXT.md` terms the user already knows, and define any other term in place.
- **What changes for the user**: what they'll see or be able to do afterwards.
- **The steps**: each ticket as one plain sentence, in order, marking which can run at the same time.
- **Risks and tradeoffs**, in plain words.
- **Decisions you need from them**, if any.

A diagram earns its place when the change moves data or ownership between parts (load `artifact-diagramming`). Write the page file to the scratchpad directory so a revision republishes to the same URL.

## Step 6: Ask for approval

Use `AskUserQuestion` with the artifact link and the ADR folder path. Options: approve, request changes. On changes, update the ADR and tickets, republish the artifact, and ask again. Implementation starts only after approval.

## Step 7: Execute

### 7a. Plan the order

1. Read every ticket; parse `blocked_by`.
2. Compare "Files to touch" across tickets. Two tickets sharing a file with no `blocked_by` between them get an implicit dependency: the higher number waits for the lower.
3. A ticket with no dependencies, explicit or implicit, is **parallel**; every other ticket is **sequential**.

Most ADRs are a chain (2 needs 1, 3 needs 2), which makes every ticket sequential and uses no worktrees.

### 7b. Spawn implementers

Spawn each ticket with the `Agent` tool:

- `subagent_type: "implementer"`
- `model`: the ticket's `assignee`
- Parallel tickets: `isolation: "worktree"`, all spawned in one message.
- Sequential tickets: no `isolation`, so the agent works on the branch and sees prior tickets' commits. One at a time, in dependency order; the next spawns only after the previous one verifies.

Set the ticket's `status: in-progress` when you spawn it.

The prompt contains:
- ADR number and title, and the path to its `index.md`
- Ticket count and which are done, blocked, ready
- This ticket's full content, including "Files to touch"
- Verbatim, at the end:
  ```
  ## REQUIRED: Commit your work

  When your implementation is complete, you MUST create a git commit.

  Stage each file you created, modified or deleted by path (other sessions may
  share this checkout), then commit:
    git add <file> <file> ...
    git commit -m "feat(adr-NNN): <ticket title>"

  Do not push.
  ```

### 7c. Verify each ticket

When an implementer finishes, spawn `subagent_type: "verifier"` (in the worktree, for a worktree ticket).

- **PASS**: set the ticket `status: done`. For a worktree ticket, merge its branch into the branch. Check which tickets are now unblocked and spawn them.
- **FAIL**: send the failure output to the same implementer with `SendMessage` (its agent ID or name) so it fixes with its context intact, then verify again. After 2 failed retries, stop and tell the user.

The implementer's report may list follow-up work outside its ticket; add each as a new ticket.

### 7d. Integration verification

With every ticket done, spawn a verifier on the branch. On FAIL, create `ticket-N-fix-integration.md`, run it through 7b and 7c, and verify again.

## Step 8: Review and fix

Spawn `subagent_type: "code-reviewer"` on the branch with the ADR folder path. It reviews everything since the merge-base with `main`, fixes every finding, and commits. Then run the verifier once more; on FAIL, send the output back to the reviewer with `SendMessage`.

Findings the reviewer marks **needs decision** go to the user in Step 9.

## Step 9: Close out

1. Set the ADR `status: accepted`, and add any reviewer findings worth remembering to Consequences.
2. Save or update a `project` memory for the ADR: number, branch, ticket count, state.
3. Report to the user: tickets done, review findings (fixed, skipped, needs decision), and the commit range.
4. Offer next steps, each run only on a yes: `pnpm test:e2e` for user-facing flows, a PR via the `pr` skill, a comment on the originating GitHub issue.
