---
name: feature
description: Use when the user asks for a new feature or a change bigger than a quick fix. Runs plan → spec → explainer artifact → (UI design loop) → GitHub tickets → build with fresh-context review per ticket → goal check → evidence → summary artifact → PR.
---

# Feature

Each stage below ends with something the user can see. Only stages 1–3 wait on the user; from stage 4 on, work through to the PR, fixing what you find without asking.

## 1. Plan with the user

Read enough code first that your questions are about choices, not facts you could look up. Then go back and forth with `AskUserQuestion`, a few questions per round, until nothing material is open. Recommend an answer for each question.

Write the result as a throwaway spec in the scratchpad (`spec.md`), not in the repo:

- **Task**: what we're building and why, in a few sentences; the files and interfaces it touches.
- **Guardrails**: what's out of scope, what must not change or break, constraints (performance, platforms, remote hosts, phone layout).
- **Done**: a checklist of observable outcomes, each one something an agent can check, e.g. "a paired phone shows X after Y". Include the evidence that proves each one (a screenshot of a state, a video of a flow, CLI output).

## 2. Explain it in an artifact

Load `artifact-design` and `artifact-diagramming`, then publish one page that someone who hasn't read the code understands in a minute:

- The problem and the change in plain words, no file paths.
- A diagram of the moving parts: what talks to what, and what changes.
- Interactive parts, e.g. click a part of the diagram to see what it does, or step through the flow before and after.
- The Done checklist and the tickets, each in one sentence.

Keep the page file in the scratchpad so revisions republish to the same URL.

## 3. Design loop (UI changes only)

Show 5 clearly different design ideas as live mockups in an artifact, built with the app's real tokens and components, in light and dark. The user picks, combines or redirects; iterate on the chosen direction until they settle. Put the final design in the spec and the explainer artifact.

Ask for approval with `AskUserQuestion`, linking the artifact. On changes, update the spec and the artifact and ask again. Nothing gets built before approval.

## 4. Tickets

`git fetch`, then create a worktree for a `feat/<slug>` branch from `origin/main`. Other sessions share the main checkout.

Create a parent GitHub issue whose body is the spec plus the artifact link. If the work won't fit in one session, split it into sub-issues, each a vertical slice that can be verified on its own, and attach them:

```
gh api repos/orrybaram/manor/issues/<parent>/sub_issues -F sub_issue_id=$(gh api repos/orrybaram/manor/issues/<child> -q .id)
```

## 5. Build each ticket

Implement the ticket and commit it, referencing the issue (`(#N)`). Use a subagent for the implementation when doing it yourself would crowd out your context.

When the ticket is done, spawn a fresh `general-purpose` agent with the ticket, the spec's Guardrails, and the commit range. It runs `pnpm typecheck` and `pnpm test`, then reviews the diff for correctness bugs and for misses against the ticket and the guardrails. Only those: a reviewer told to find gaps always finds some, and polishing every one over-engineers the change. It reports and doesn't edit. Fix what it reports, then close the sub-issue with a one-line comment.

## 6. Check the goal

Spawn a fresh agent with the spec and the branch. It checks every Done item against the running code and reports each one as met or not, with how it checked. Fix the misses and check again.

## 7. Evidence

Capture the evidence each Done item names, in the scratchpad:

- Screenshots of every new or changed state, in light and dark.
- Video of multi-step flows: a Playwright spec with `recordVideo`, the `run` skill, or the manor recorder for browser panes.
- Terminal output for changes with no UI.

Run Playwright yourself, in the background. Open every screenshot with `Read` and check it against the spec: layout, text, both themes, nothing clipped, no error toasts. You can't watch a video, so screenshot its key steps too. Fix anything wrong, recapture, and repeat until a full pass is clean.

## 8. Summary and PR

Publish a summary artifact with:
- What was built, ticket by ticket.
- Anything that changed from the spec.
- The Done checklist, each item next to the evidence that proves it.
- Review findings and how each was handled.
- Anything you couldn't show, and why.

Read it back (`action: "read"`, `scope: "files"`) to confirm every image and video resolves.

Push the branch and open the PR with the `pr` skill. Link the summary artifact, close the parent issue (`Closes #N`), and host the PR's images on the `pr-assets` branch. Report the PR and artifact links to the user.
