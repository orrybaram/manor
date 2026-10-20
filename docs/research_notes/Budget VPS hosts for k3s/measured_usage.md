# Measured agent resource usage (this machine, 2026-10-15)

Source: a 180-second sample (2s interval) from /proc on the user's dev box, which runs Manor plus 9 Claude Code agent processes (5 of them actively working: feature implementation, lint, tests). The box is WSL2 with 16 vCPU and about 7.7 GB of RAM. CPU and RSS are attributed to each `claude` process including all its child processes (tsc, eslint, vitest, git, etc.). This is roughly what one Manor project pod would contain. A pod also runs the Manor host server: ~80 MB RSS, near-zero CPU.

## Per agent (cores; RSS in MB)
| Agent state | avg CPU | p95 CPU | max CPU | avg RSS | peak RSS |
|---|---|---|---|---|---|
| idle (5 agents) | 0.01–0.08 | ≤0.23 | ≤0.41 | 220–500 | ≤535 |
| active, editing/thinking | 0.25–0.27 | ~1.7 | ~2.2 | ~560 | ~1,390 |
| active, running `pnpm lint` + tests (pod-per-project worktree) | 0.45 | 2.05 | 9.67 | 736 | 3,527 |

Lifetime averages from `ps` (CPU time / wall time) for the claude processes alone: 2–7.5% of one core.

## Whole machine
- 16 cores. Total CPU use across the sample: avg 3.3 cores, p95 13.7, max 14.4. The peaks come from concurrent lint/typecheck/test bursts. The 1-minute load average reached 15.
- A single eslint run over the manor repo used ~870 MB RSS by itself.

## Implications for pod and node sizing
- CPU is bursty. The steady state is ~0.05–0.5 cores per agent, but builds want 2–10 cores for tens of seconds. That fits a low CPU request (0.25–0.5) with no CPU limit, which the Kubernetes template already leaves unset, sharing a node's idle cores.
- Memory is the binding constraint. Active agents average ~0.6–0.75 GB, but lint/test spikes reach 1.4–3.5 GB. A suggested pod size is a 1 GiB memory request and a 4 GiB limit; a 2 GiB limit would OOM-kill on lint of a manor-sized repo.
- For 8 pods with ~3 building at once, the node needs ~8 vCPU and ~16 GB as a minimum; 24–32 GB is comfortable. The original Medium preset (2 CPU / 4 GiB requests) overstates CPU about 4–8× for these agents.
- Caveat: one 3-minute sample on a single machine. CPU is shared with the desktop, and repo size drives the build peaks.
