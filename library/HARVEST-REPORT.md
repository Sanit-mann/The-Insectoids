# Library Harvest Report

**Date:** 2026-11-12
**For:** function 03 Capabilities (D5, D8)
**Raw data:** [catalog/source-inventory.tsv](catalog/source-inventory.tsv) (every item found) · [catalog/duplicate-groups.tsv](catalog/duplicate-groups.tsv) (name-based duplicate groups)

---

## 1. What the 9 repos contain

| Repo | License | Agents | Skills | Commands | Character |
|---|---|---|---|---|---|
| ruvnet/ruflo | MIT | 155 | 316 | 206 | Huge; ~312 items tied to Ruflo's own CLI/AgentDB/federation; same item often exists 3× (agent + skill + command) |
| affaan-m/ecc | MIT | 75 | 315 | 105 | Broad, high quality; per-language reviewers & build fixers; many framework skills; translated copies (skipped) |
| msitarzewski/agency-agents | MIT | 271 | 0 | 0 | Widest role coverage: engineering 66, specialized 59, marketing 37, game-dev 21, GIS 13, design 10, testing 9, sales 9, PM 7, paid media 7, support 6, spatial 6, product 6, academic 6, finance 5, healthcare 3 |
| obra/superpowers | MIT | 0 | 15 | 0 | Small, excellent *process* skills: brainstorm → plan → TDD → debug → review → verify → finish |
| juliusbrussee/caveman | Apache-2.0 | 3 | 22 | 9 | Token-saving output modes (lite/full/ultra), memory-file compression, terse reviewer; 7 skills only work with the paid "Caveman Cloud" |
| multica-ai/andrej-karpathy-skills | MIT (README) | 0 | 1 | 0 | One skill: behavioral guidelines against common LLM coding mistakes |
| vercel-labs/agent-browser | Apache-2.0 | 0 | 11 | 0 | Browser-automation CLI + skills (core, dogfood QA, Electron apps, Slack, reverse-engineer APIs) |
| vercel-labs/agent-skills | MIT (README) | 0 | 9 | 0 | React/Next.js performance, composition, view transitions, React Native, web design & writing guidelines, Vercel deploy |
| microsoft/playwright-mcp | Apache-2.0 | — | — | — | A **tool**, not skills: MCP server for browser automation via accessibility tree |

**All licenses permit adapting with attribution.** Translations, mirror folders and dependency folders were skipped.

## 2. Totals after automatic triage

| Step | Count |
|---|---|
| Unique items found (after removing mirrors/translations) | **1,513** |
| Tied to one product's own runtime (Ruflo 312, ECC 26, Caveman Cloud 12) | −350 |
| Thin command wrappers (mostly 10–60 line shortcuts to an agent or skill) | most of ~230 remaining commands |
| Name-based duplicate groups found | 144 groups (335 items) |
| **Realistic library after merging true duplicates** | **~500–650 agents + skills** |

Name matching only catches obvious duplicates. Many overlaps have different names (e.g. ECC `security-reviewer`, agency-agents `Security Engineer`, Ruflo `security-audit`), so the final merge needs reading the content, not just names.

## 3. Key duplicate clusters and merge plan (examples)

| Capability | Sources | Plan |
|---|---|---|
| Test-driven development | superpowers `test-driven-development`, ECC `tdd-workflow` + `tdd-guide` agent, Ruflo `tdd`/`tdd-repair`, ECC/Ruflo `/tdd` commands | **Merge:** superpowers' strict red-green-refactor discipline + ECC's coverage targets and per-language test commands |
| Code review | ECC `code-reviewer` + 15 language reviewers, agency `Code Reviewer`, superpowers `requesting-`/`receiving-code-review`, caveman `caveman-review` + `cavecrew-reviewer` | **Merge** into Reviewer caste: ECC's confidence-filtered checklist + superpowers' "how to receive feedback" + caveman's one-line-per-finding output format. Keep language reviewers as dormant sub-skills |
| Planning | superpowers `writing-plans` + `brainstorming`, ECC `planner`, Ruflo `planner` | **Merge** for the Queen: brainstorm → written plan with tasks sized for one insect each |
| Debugging | superpowers `systematic-debugging`, caveman `investigate-first`, ECC build-error resolvers | **Merge** core method; keep build resolvers per language |
| Verification | superpowers `verification-before-completion`, caveman `verify-and-stop` | **Merge** → Inspector's main skill |
| Parallel work / orchestration | superpowers `dispatching-parallel-agents` + `subagent-driven-development`, Ruflo hive/queen/swarm, ECC `orchestrate` | **Merge** ideas into Queen + Foreman (02-Hive), drop Ruflo-locked parts |
| Browser automation | agent-browser (CLI + skills), playwright-mcp (MCP), Ruflo `browser*`, ECC `browser-qa` | **Keep both tools:** agent-browser CLI for insects (fewer tokens; Playwright's own README says CLI + skills is more token-efficient for coding agents), Playwright MCP for long interactive sessions. One merged "browser" skill on top |
| Token saving | caveman modes + `caveman-compress`, Ruflo `cost-compact-context`, Karpathy guidelines | **Merge:** compact mode for agent-to-agent messages and Brain summaries; normal language for the user |
| Git & branches | superpowers `using-git-worktrees` + `finishing-a-development-branch`, ECC `git-workflow`, caveman `caveman-commit` | **Merge** |
| SEO, architect, data engineer, performance, chief of staff, tech writer | ECC + agency-agents + Ruflo + agent-browser | **Merge** pairwise, keep the longer, more concrete one as base |

## 4. Proposed mapping to our castes

| Our caste/role | Main sources |
|---|---|
| Queen | superpowers planning/brainstorm/dispatch, Ruflo queen + hive ideas |
| Managers | Ruflo optimization agents (ideas only), ECC `loop-operator`, `harness-optimizer`, cost skills |
| Coder | ECC language patterns + build resolvers, Vercel React skills, caveman `surgical-patch`/`safe-refactor`/`lean-build`, Karpathy guidelines |
| Tester | superpowers TDD, ECC `e2e-runner`, `tdd-guide`, agent-browser `dogfood` |
| Reviewer | merged review cluster above |
| Researcher | ECC `deep-research`, `search-first`, agency academic/research |
| Documenter | agency `Technical Writer`, agent-browser `technical-writer`, ECC `doc-updater` |
| Designer | agency design (10), Vercel web-design guidelines, ECC frontend/UI skills |
| Analyst | agency finance, data, product; ECC data skills |
| Writer | agency marketing (37), sales, support; Vercel writing guidelines |
| *Dormant specialists* | agency game-dev, GIS, spatial, healthcare; ECC niche languages/frameworks |

## 5. Decision needed: how much to rewrite now

Rewriting means reading each source, merging duplicates, removing fluff, safety-scanning, and writing our own version. Roughly 1,000+ source files feed ~500–650 final items: millions of tokens of reading.

| Option | What happens | Cost |
|---|---|---|
| **A. Core now, rest catalogued** *(recommended)* | Fully rewrite the ~100–150 items the hive needs on day one (15 role agents + core process, review, test, debug, plan, browser, git, token-saving, TS/JS + Python skills). Every other item goes in the catalog as *dormant, not yet rewritten*; it gets rewritten in later batches or the first time a task needs it | Moderate; uses parallel helper agents |
| **B. Everything now** | Rewrite all ~500–650 items in waves by category | Heavy; many parallel helper agents over several sessions |
| **C. Catalog only** | No rewriting; catalog all with metadata, vet and rewrite only on first use | Cheapest, but originals stay unmerged until used |
