# 02 — Hive (Agent Hierarchy & Taskboard)

**Status:** Finalized (2026-11-12)
**Created:** 2026-11-12
**Last updated:** 2026-11-12

---

## Inspiration

The **Insectoids**, a fictional insect race with a strict hierarchy: every insect has its own body and brain, yet all share one consciousness. The AIOS copies this:

| Insectoid | AIOS |
|---|---|
| Queen | Orchestrator agent |
| Middle castes | Manager agents that keep the hive at optimum (fast, efficient, effective) |
| Insects | Worker sub-agents that do the tasks |
| Own body & brain | Each agent runs as its own process with its own memory shelf |
| Shared consciousness | The Brain (function 01), read and written by all |

## Purpose

Turn one goal into finished work by splitting it into small tasks that many agents complete in parallel, with a clear chain of command.

## What the user asked for (original words, summarized)

- **One Queen** (orchestrator).
- **Multiple insects** (sub-agents that do the work).
- The Queen **divides a task into parts and posts them on a taskboard**.
- Insects **come, pick one task, do it, then pick the next** (pull model).
- **Manager agents** between Queen and insects keep the OS at optimum conditions (fast, efficient, effective, etc.).
- Learn from **Ruflo's** swarm management.

## How it works (current understanding)

1. User gives the Queen a goal.
2. Queen breaks it into tasks and posts them on the taskboard (stored in the Brain's `tasks` table).
3. Idle insects pull the next suitable task, do it, report the result, pull another.
4. Managers watch the hive and step in to keep it fast, cheap and correct.
5. Queen assembles the results and reports back to the user.

## Taskboard design (adopted 2026-11-12, D10)

Each task card holds:

| Field | Purpose |
|---|---|
| id, title, brief | What to do; brief built by the Brain (E4) |
| goal_id | Which user goal it belongs to |
| depends_on | Tasks that must finish first; card stays locked until they do |
| skill | Kind of insect needed (coding, testing, research, …) |
| priority | Critical / high / normal / low |
| acceptance | How we know it's done right |
| status | open → claimed → in progress → (blocked) → review → done / failed |
| claimed_by + lease | Who has it, and until when; lease renewed while working |
| attempts | Retries so far; after the limit, escalate |
| result | Output summary + links to files changed |

**Key rules:**
- **Atomic claim:** claiming goes through the Brain's single writer (D14 in 01), so two insects can never grab the same card.
- **Leases:** if an insect crashes or stalls, its lease expires and the card returns to the board automatically.
- **Retry then escalate:** a failed task is retried up to N times, then escalated to a manager or the Queen.
- **Status written by the harness, not the LLM:** progress and heartbeats are recorded by the AIOS process for free, instead of agents spending tokens writing status every 30 seconds (a Ruflo weakness).

## Managers (adopted; built as "reflexes + brain", D8)

| Manager | Job | Mostly code or LLM? |
|---|---|---|
| **Foreman** (scheduler) | Balances the board: spawns or retires insects, unblocks stuck cards, reassigns expired leases | Mostly code |
| **Inspector** (quality) | Checks finished work against acceptance criteria before it is marked done | LLM |
| **Treasurer** (budget & routing) | Tracks tokens, cost and rate limits per user subscription; sends each task to the cheapest model that can do it; stops runaway spending | Mostly code |
| **Librarian** (memory keeper) | Maintains the Brain: dedupe, consolidation, audits, health score | Mix |
| **Watchdog** (health) | Detects loops, crashes, stalls; kills or restarts agents | Code |
| **Scout** (explorer, optional) | Surveys a codebase or topic before the Queen plans | LLM |

## Reference: Ruflo hive-mind (github.com/ruvnet/ruflo)

| Part | What Ruflo does |
|---|---|
| Queen types | Strategic (planning/research), Tactical (execution), Adaptive (adjusts to performance) |
| Governance modes | Hierarchical (direct command), Democratic (weighted votes), Emergency (queen overrides) |
| Roles | Queen; Collective-intelligence (consensus, knowledge, heir to queen); Workers; Scouts (explore, report threats/opportunities, never change code); Memory manager |
| Worker specializations | Researcher, Coder, Analyst, Tester, Architect, Reviewer, Optimizer, Documenter; custom ones via YAML |
| Assignment | **Push**: system assigns by keyword match, past performance, load and complexity (best matches cached 5 min) |
| Consensus | Majority, Weighted (queen vote ×3), Byzantine (⅔ supermajority) |
| Auto-scaling | Add workers when pending tasks ≥ 2 per idle worker; remove when idle workers exceed pending by 2; capped by maxWorkers |
| Collective memory | SQLite (WAL) + cache; memory types with expiry: task 30 min, context 1 h, error 24 h, knowledge/results permanent |
| Worker protocol | Writes status → progress → blocked → complete records to shared keys `swarm/worker-<id>/…` |
| Sessions | Checkpoints; `pause`, `resume`, `stop`, `export`/`import` a hive session |
| Queen reporting | "Royal report" every 2 min: objectives done/pending, utilization, recommendations |

**Worth adopting:** queen types by task kind; worker specializations; scouts that look but never touch; auto-scaling by queue length; memory types with expiry; pause/resume of a whole hive; consensus only for disputed decisions.

**Weak spots to avoid:**
- No method for *how* the queen splits a goal into tasks.
- No pull model and no taskboard: workers wait to be assigned.
- No retry or reassignment when a worker fails.
- Agents write status every 30–60 s, which burns tokens.
- Theatrical fields ("morale", "coup prevention", "rebellious agents") with no implementation; fixed resource splits.

## Reference: model switching & monitoring (researched 2026-11-12)

### Ruflo — automatic model routing
| Tier | Handler | Speed | Cost/call | Used for |
|---|---|---|---|---|
| 1 | "Agent Booster" (local code, no LLM) | < 1 ms | $0 | Tiny mechanical edits (var→const, add types, remove console logs) |
| 2 | Haiku / Sonnet | ~0.5–2 s | ~$0.0002–0.003 | Bug fixes, refactors, features |
| 3 | Opus (+ swarm) | ~2–5 s | ~$0.015 | Architecture, security design, complex systems |

- **How it picks:** a `pre-task` hook scores the task, then a learning selector (v3.7: a cost-adjusted "multi-armed bandit"; each tier has a success score updated from outcomes via `hooks_model-outcome`) picks the tier via `hooks_model-route`. Claimed to self-correct after ~50 outcomes, 45 µs per decision. Older docs say Q-learning instead; unclear which is current.
- **Providers:** Anthropic, OpenAI, Google, Cohere, Ollama, with automatic failover to the cheapest provider meeting quality needs.
- **Effort/reasoning level:** not handled.
- **Monitoring:** console ("agent cockpit") tracks agents, models, tokens and cost; open logs, triage failures, replay and compare runs; cost-tracker plugin with budgets and alerts.
- **Claims (unverified, no method shown):** 75% lower API cost, 89% routing accuracy, 250% longer Claude Code usage.

### Munder Difflin — manual model choice, strong visibility
- **Model choice:** made when "hiring" an agent: pick its CLI, model and autonomy. Engines can be mixed in one office. No automatic per-task routing; no effort/reasoning control.
- **Budgets:** per-agent and office-wide token limits per period (5 h, day, week, month); real cost read from transcripts into a ledger; cap on short-lived "temp" agents.
- **Circuit breaker:** a ladder of *steer → constrain → stop* for agents that loop, repeat errors or overspend; no repeat warning within 10 min.
- **Seeing who does what:** office floor (avatars, envelopes between desks), click a desk to see its live terminal, per-agent task history, live status line per agent, "Asked you" flag, Command Center (kanban, fleet monitor, activity log), cost and tool-call traces.
- **Hierarchy:** only one supervisor (Michael, the "GOD agent"); no managers below him.

## Reference: how Ruflo builds its managers

- **What they are:** Markdown prompt files in `.claude/agents/` (e.g. `optimization/` has load-balancer, performance-monitor, resource-allocator, topology-optimizer, benchmark-suite; `swarm/` has hierarchical, mesh and adaptive coordinators; `consensus/` has raft, quorum, byzantine, gossip, CRDT managers).
- **Format:** frontmatter with only `name` and `description` (no model, tools or hooks), then a long prompt: profile, capabilities, algorithms, example commands, metrics.
- **Real or not:** the code blocks inside are *illustrative*: they call classes and functions that are never defined, so they don't run. The agents are instructions an LLM reads. The real mechanics (routing, metrics, scaling, memory) live in Ruflo's own TypeScript CLI/MCP server as tools the agent calls (`agent_metrics`, `load_balance`, `swarm_status`, `performance_report`, …).
- **Lesson:** Ruflo already splits managers into a *prompt* (judgment) and *code tools* (mechanics). Its model router is pure code (45 µs), not an LLM. This supports the "reflexes + brain" proposal (Q4).
- **Weak spot:** its manager prompts describe advanced algorithms (genetic allocation, LSTM anomaly detection, work-stealing) that the LLM cannot actually run; they read impressive but do little. Our managers should only claim what their code tools really do.

## Proposed additions from this research (not yet agreed)

- **P1 — Model + effort router (inside the Treasurer).** For each task card, pick the model *and* the effort/reasoning level from the user's connected subscriptions (Claude effort levels, OpenAI reasoning effort, Gemini thinking budget, local models). Start from simple rules (caste + task size + priority), then learn from outcomes recorded in the Brain (which model/effort succeeded, cost, time, retries), like Ruflo's bandit. Tier 0 = plain code for mechanical jobs (no LLM at all). Escalate to a stronger model/effort on failure.
- **P2 — Hive monitor view (in the GUI, alongside 01-D13).** Live board of every agent: role/caste, current task, model + effort, tokens and cost so far, status (working / waiting / blocked / asking), with a click-through to its live output — inspired by Munder Difflin's office floor and Ruflo's console.
- **P3 — Breaker ladder for the Watchdog.** Steer → constrain (lower effort/model, fewer tools) → stop, with per-agent and hive-wide budgets per period.

## Inputs / Outputs

- **Inputs:** a goal from the user; results from insects.
- **Outputs:** finished work, a report to the user, records in the Brain (tasks, outcomes, decisions proposed).

## Dependencies on other functions

- **01 Memory:** taskboard = Brain `tasks` table; each agent's own shelf = per-agent memory; shared consciousness = shared shelf; task briefs (E4), handoffs (E2), outcomes and lessons (E5/E10) feed better assignment; single writer (D14) makes task claims safe.

## Open questions

- [x] Q1 — Who talks to the user → only the Queen (D4).
- [x] Q2 — Planning → waves; user approves plans for big goals (D5).
- [x] Q3 — Insects → castes; Queen on strongest model (D6). *Insect models deferred → Q6.*
- [x] Q4 — Managers → agents built as "reflexes + brain" (D8).
- [x] Q5 — Limits and approvals → Claude's suggestion (D7).
- [x] Q6 — Insect models → chosen per task by the model + effort router (D9). User can still set preferences/limits later.
- [x] Q7 — P1, P2, P3 → all accepted (D9).

*All open questions closed as of 2026-11-12.*

### Q4 notes: managers as full LLM agents — disadvantages

| Problem | Why it matters |
|---|---|
| Token cost | A manager that "thinks" every time it checks the hive spends tokens all day, even when nothing is wrong. Conflicts with goal "lowest token wastage". |
| Speed | An LLM takes seconds per decision; a crash, loop or overspend needs a reaction in milliseconds. |
| Shared rate limits | Managers draw from the same user subscriptions insects need, so the hive does less real work. |
| Reliability | LLMs can miscount or misremember mechanical facts (lease timers, budgets); code never does. |
| Who watches the watchdog? | If the Watchdog is itself an LLM, it can also loop or stall. |

**Proposal — "reflexes + brain" (keeps managers as agents):** each manager is a real agent with its own identity, memory shelf and voice to the Queen. Its *reflexes* are code (sensors and rules that run instantly and free: lease expiry, budget caps, loop detection). Its *brain* (LLM) wakes only on events that need judgment (unusual failures, conflicts, tuning) or for a periodic review, e.g. every N finished tasks. Like an insect: legs move by reflex, the brain decides only when needed.

## Decisions made

- **D1 (2026-11-12) — Hierarchy:** Queen → Managers → Insects.
- **D2 (2026-11-12) — Pull-based taskboard:** Queen posts tasks; insects pick one, finish it, pick the next.
- **D3 (2026-11-12) — Shared consciousness is the Brain (01):** every agent has its own memory shelf plus the shared one.
- **D4 (2026-11-12) — Only the Queen talks to the user.** Managers and insects route questions, approvals and reports through the Queen. One clear voice; no interruptions from every agent.
- **D5 (2026-11-12) — Planning in waves.** The Queen plans a first wave of tasks, learns from results, then plans the next. Big goals: the user approves the plan before insects start. Small goals: approved automatically. (Threshold for "big" to be set later.)
- **D6 (2026-11-12) — Castes, Queen on the strongest model.** Insects belong to castes (e.g. coder, tester, researcher, reviewer, documenter) and only pick cards matching their caste. The Queen runs on the user's strongest available model. Insect models decided later (Q6).
- **D7 (2026-11-12) — Limits and approvals.**
  - The user sets the maximum number of insects running at once; the Treasurer lowers it automatically when a subscription nears its rate limit.
  - Always need user approval: deleting files or data, spending money, publishing or posting anything public, pushing code to shared repositories, and anything else destructive, costly or public.
- **D8 (2026-11-12) — Managers are agents built as "reflexes + brain."** Each manager (Foreman, Inspector, Treasurer, Librarian, Watchdog, Scout) is a real agent with its own identity, memory shelf and voice to the Queen.
  - *Reflexes* = code tools that run instantly and free (lease expiry, budget caps, loop detection, load balancing, metrics).
  - *Brain* = LLM, woken only for judgment calls (unusual failures, conflicts, tuning) and a periodic review (e.g. every N finished tasks).
  - Managers only claim what their code tools actually do (avoid Ruflo's "prompt-only algorithms").
- **D9 (2026-11-12) — Model routing, monitoring and breaker accepted (P1–P3).**
  - **P1 Model + effort router** (part of the Treasurer): picks model *and* effort/reasoning level per task from the user's connected subscriptions; starts rule-based (caste, size, priority), then learns from outcomes in the Brain; Tier 0 = plain code, no LLM; on failure, retry with a stronger model or higher effort. Answers Q6.
  - **P2 Hive monitor view** in the Brain GUI: every agent's role/caste, task, model + effort, tokens and cost, status, click-through to live output.
  - **P3 Breaker ladder** (Watchdog): steer → constrain → stop, with per-agent and hive-wide budgets per period.
- **D10 (2026-11-12) — Taskboard design adopted as written** (fields, atomic claim, leases, retry then escalate, status recorded by the harness).
- **D11 (2026-11-12) — Default "big plan" threshold (amendment A1).** Until the user sets their own, a plan is big if it has more than one wave, touches shared or public resources, contains any D7 action, or the Treasurer's estimate exceeds the per-goal budget. Big plans need user approval (D5).
- **D12 (2026-11-12) — Watchdog alert exception to D4 (amendment A2).** If the Queen herself loops, stalls or crashes, the Watchdog may pause her and show an alert in the hive monitor view. This is the only case where an agent other than the Queen reaches the user.

## Amendments (approved by user 2026-11-12 → D11, D12)

- **A1 — Default "big plan" threshold** (fills the gap in D5): until the user sets their own, a plan is *big* if it has more than one wave, touches shared or public resources, contains any D7 action, or the Treasurer's estimate exceeds the per-goal budget. Currently written into `library/agents/queen/AGENT.md`.
- **A2 — Watchdog alert exception to D4:** if the Queen herself loops, stalls or crashes, the Watchdog may pause her and show an alert in the hive monitor view. This is the only case where an agent other than the Queen reaches the user. Currently written into `library/agents/watchdog/AGENT.md`.

## Change log

- 2026-11-12 — Created from the user's description; added Ruflo hive-mind reference and draft taskboard/manager designs.
- 2026-11-12 — Q1, Q2, Q3, Q5 answered → D4–D7. Q4 trade-offs and "reflexes + brain" proposal added. Q6 (insect models) deferred.
- 2026-11-12 — Researched model switching and monitoring in Ruflo and Munder Difflin, and how Ruflo builds managers. Added proposals P1–P3 and Q7.
- 2026-11-12 — User accepted all: D8 (reflexes + brain managers), D9 (P1–P3; closes Q6). All questions closed.
- 2026-11-12 — **Finalized by user**, adopting the taskboard design (D10). Further changes go through a new change-log entry.
- 2026-11-12 — Amendments A1 and A2 (raised while writing the Queen and Watchdog agents) approved by user → D11, D12.
