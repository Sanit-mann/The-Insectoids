# 03 — Capabilities (Agents & Skills)

**Status:** Finalized (2026-11-12)
**Created:** 2026-11-12
**Last updated:** 2026-11-12

---

## Purpose

Define **what every agent in the hive is** (its caste, role and permissions) and **what it can do** (its skills and tools), so the Queen can plan with known abilities and insects can pick only the tasks they are fit for.

## What the user asked for

- Decide **Capabilities first**: **agents** and **skills**. (This is the "Capabilities" C of the 4Cs.)

## Three building blocks (proposed)

| Block | What it is | Example |
|---|---|---|
| **Agent (caste definition)** | A template that makes an agent: role, rules, default skills, allowed tools, permissions, model hints for the router | "Tester: writes and runs tests, may run code in a sandbox, may not push code" |
| **Skill** | A reusable "how to do X" playbook, loaded only when needed | "write-unit-tests", "review-security", "summarize-meeting" |
| **Tool** | A real action the agent can perform, usually through MCP or the AIOS itself | read/write files, run terminal, web search, Brain read/write, GitHub |

**Rule of thumb:** *agents are who, skills are how, tools are with what.*

## Draft: agent definition (one file per caste, proposed)

| Field | Purpose |
|---|---|
| name, rank | e.g. Coder / insect; Inspector / manager; Queen |
| role & rules | Short system prompt: what it does, what it never does |
| skills | Skills it carries by default; may load others it is allowed |
| tools | Allowed tools only (least privilege, "Intern Rule" from 3Ms) |
| permissions | Files (read/write/where), terminal, internet, external services, approvals needed |
| model hints | Minimum model tier / effort for the router (02-D9 P1) |
| memory shelf | Its own Brain shelf (01-D2) |
| lifecycle | Fresh per task, or long-lived |

## Draft: launch roster (proposed)

| Rank | Agents |
|---|---|
| Queen | Queen |
| Managers | Foreman, Inspector, Treasurer, Librarian, Watchdog, Scout (from 02) |
| Insect castes | **Coder**, **Tester**, **Reviewer**, **Researcher**, **Documenter**, **Designer** (UI/UX), **Analyst** (data/numbers), **Writer** (non-code text: emails, posts) |

## Draft: skills (proposed)

- **Format:** the open **Agent Skills standard** (`SKILL.md` folder: name + description + instructions, optional scripts and references). Released by Anthropic in Dec 2025 at agentskills.io, now supported by 30–40+ tools including Claude Code, Codex, Cursor, Gemini CLI, Copilot. Fits 01-D5 (tool-agnostic): the same skill works whatever CLI the user signs into.
- **Token saving built in:** agents see only each skill's name + one-line description; the full instructions load only when the skill is used ("progressive disclosure").
- **Sources:** built-in skills shipped with the AIOS; skills the user writes; skills imported from community libraries (vetted first).
- **Skill registry in the Brain:** each skill recorded with owner caste(s), version, success rate and token cost from outcomes, so the router and Queen know which skills work.

## Dormant library design (D8)

**Problem it solves:** if hundreds of agents and skills are all "installed", every agent pays tokens just to see their names and descriptions at every start, and picks the wrong one more often. (This very build session shows it: several hundred skill names sit in Claude's context all the time.)

**How it works:**

1. **Library on disk:** all agents and skills stored in the AIOS library folder, in the standard format, never loaded by default.
2. **Catalog in the Brain:** one row per agent/skill: name, one-line description, castes, tags, source repo, license, version, safety status, success rate, token cost, last used.
3. **Find:** when the Queen plans a wave (or an insect starts a card), the brain searches the catalog by keyword + meaning and returns only the few best matches.
4. **Activate:** the harness makes just those skills/agents visible to that one insect for that one task (e.g. placing them in the tool's skill folder for that session, or injecting them into its brief).
5. **Deactivate:** when the task ends, they disappear again. Outcomes update the catalog (worked? cost?).
6. **Warm set:** a small set the user or the usage stats mark as "always on" (e.g. top 5–10 per caste) stays active to avoid repeated searching.

**Budget rule (proposed):** an insect never carries more than a small number of active skills at once (e.g. ≤ 5), keeping its context lean.

## Harvesting process: building our library from GitHub repos

For each repo the user supplies:

1. **Read** its agents, skills and tools.
2. **Check license:** MIT/Apache/BSD → can adapt with attribution; no license or restrictive → ideas only, rewritten from scratch.
3. **Classify:** map each item to our castes and skill categories; note overlaps.
4. **Dedupe & merge:** where several repos have the same skill, keep the best parts in one version.
5. **Rewrite in our format:** Agent Skills standard; trim fluff and "prompt-only algorithms" (02 lesson); make them tool-agnostic.
6. **Safety scan (D5)**, then mark as *vetted*.
7. **Register** in the catalog as dormant, with source and license recorded.

## Harvest status

- **2026-11-12:** 9 repos inventoried (ruflo, ecc, agency-agents, andrej-karpathy-skills, superpowers, caveman, agent-browser, agent-skills, playwright-mcp). 1,513 unique items; ~350 product-locked; 144 name-based duplicate groups; realistic final library ~500–650. Full report: [library/HARVEST-REPORT.md](../library/HARVEST-REPORT.md). User chose option A (D9).
- **2026-11-12 — Core set built.** 65 items rewritten and merged by 9 parallel helpers: 15 agents (Queen, 6 managers, 8 castes), 48 skills, 2 tools ([CORE-SET.md](../library/CORE-SET.md)). All passed a format check, strict YAML parse and a safety scan; licenses and notices recorded in [THIRD-PARTY-NOTICES.md](../library/THIRD-PARTY-NOTICES.md). Status `vetted` = safety-reviewed, **not yet field-tested** in real tasks.
- **Catalog:** [catalog/CATALOG.md](../library/catalog/CATALOG.md) + `catalog.json`: 65 active items and **879 dormant entries** (not yet rewritten; castes are an automatic guess; many still overlap and will be merged when rewritten). Skipped: 350 product-locked, 137 thin command shortcuts; 99 source files already merged into the core set. Scripts to rebuild it: `library/catalog/scripts/`.
- **Fixes made in review:** Postgres `$1` placeholders replaced (some AI tools substitute `$N`); two unquoted YAML descriptions quoted; a Django backfill example that could loop forever rewritten; field conventions added to FORMAT.md.
- **Notable source problems caught by helpers:** remote rule-loading (Vercel writing/design guidelines fetch rules from GitHub at runtime: not fetched, rewritten), fake-review "astroturfing" advice (now forbidden in Writer), credential-handling and webhook-export scripts (dropped), several outdated or wrong technical claims (corrected, marked "as of").

## Reference: how others do it

| Project | Agents | Skills |
|---|---|---|
| **Ruflo** | 100+ agent prompt files in folders (core, swarm, consensus, optimization, testing, github, …); frontmatter only name + description | Many skills under `.agents/skills/` |
| **AIS-OS** | One main assistant | 6 skills (`/onboard`, `/grill-me`, `/audit`, `/link`, `/level-up`, `/3d-brain`); kept in `.claude/skills/` and synced to a Codex copy by script |
| **claude-obsidian** | 3 read-only helper agents (ingest, lint, verifier) | Skills in Agent Skills format, usable in Claude Code, Codex, OpenCode, Gemini, Cursor, Windsurf |
| **Munder Difflin** | "Hire" agents: pick CLI, model, autonomy; long-lived + short-lived "temps" | — |

**Lessons:** Ruflo shows that 100+ agents is too many to manage (most overlap); AIS-OS shows a small, sharp skill set works; claude-obsidian shows read-only helpers + one writer is safe; Munder Difflin shows long-lived vs temporary agents.

## Inputs / Outputs

- **Inputs:** caste and skill definitions (built-in, user, community); outcomes from the Brain.
- **Outputs:** the roster the Queen plans with; the skill set each insect loads per task; permission checks the harness enforces.

## Dependencies on other functions

- **01 Memory:** each agent's shelf; skill registry and outcomes stored in the Brain; secrets guard (E6).
- **02 Hive:** castes decide which cards an insect can pull (02-D6); managers defined here as agents (02-D8); model hints feed the router (02-D9).

## Open questions

- [x] Q1 — Scope → both software and general work (D2).
- [x] Q2 — Castes → all 8, new ones built when needed (D3).
- [x] Q3 — Skill format → open Agent Skills standard (D4).
- [x] Q4 — Sources & safety → built-in + user + community; community scanned and approved (D5).
- [x] Q5 — Self-learning → yes (D6).
- [x] Q6 — Lifecycle → fresh insects per task; Queen and managers long-lived (D7).

*All questions closed. Next step: user supplies GitHub repos to harvest into the library (D8).*

## Decisions made

- **D1 (2026-11-12) — Capabilities is function 03**, covering agents and skills.
- **D2 (2026-11-12) — Scope: software and general work.** Core castes cover software; Writer, Analyst and Researcher cover research, writing, marketing and business tasks.
- **D3 (2026-11-12) — Launch roster: all 8 insect castes** (Coder, Tester, Reviewer, Researcher, Documenter, Designer, Analyst, Writer) plus Queen and the 6 managers. New castes are created when a need appears (proposed by the Queen/Librarian, approved by the user).
- **D4 (2026-11-12) — Skills use the open Agent Skills standard** (`SKILL.md` folders), so they work across Claude Code, Codex, Cursor, Gemini CLI, Copilot and other supporting tools. Agent definitions follow the same frontmatter + Markdown style.
- **D5 (2026-11-12) — Skill sources and safety.** Three sources: built-in, user-written, community imports. Every imported skill or agent is scanned (hidden instructions, data exfiltration, risky scripts, secrets) and approved by the user before it can be activated. Built-in ones are vetted before shipping.
- **D6 (2026-11-12) — Self-learning skills.** The AIOS proposes new skills when it sees the same successful work repeated (e.g. 3+ times) and proposes retiring skills that keep failing or go unused. The user approves both.
- **D7 (2026-11-12) — Fresh insects per task.** Each task gets a new insect with a clean context, primed by the Brain's task brief (01-E4) and handoff (01-E2). The Queen and managers are long-lived.
- **D8 (2026-11-12) — Big dormant library, activate only what's needed.** The AIOS ships with a large prebuilt library of agents and skills (target: hundreds), built by Claude from GitHub repos the user supplies. Everything is **dormant by default**; only what a task needs is activated, then deactivated afterwards. See "Dormant library design".
- **D9 (2026-11-12) — Rewrite scope: option A, "core now, rest catalogued".** The core set the hive needs on day one is fully merged and rewritten now (list: [library/CORE-SET.md](../library/CORE-SET.md); format: [library/FORMAT.md](../library/FORMAT.md)). Every other harvested item goes into the catalog as dormant and *not yet rewritten*, to be rewritten in later batches or on first use.

## Change log

- 2026-11-12 — Created; draft building blocks, agent definition, launch roster, skills approach, references and questions.
- 2026-11-12 — Q1–Q6 answered → D2–D7. User added dormant-library requirement → D8, with library design and harvesting process.
- 2026-11-12 — Harvest of 9 repos; user chose option A → D9; core library built (65 items) and catalog generated (879 dormant).
- 2026-11-12 — **Finalized by user.** Further changes go through a new change-log entry.
