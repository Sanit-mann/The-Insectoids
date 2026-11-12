# Core Set (rewritten now, per 03-D9)

The items the hive needs on day one. Each is merged from the listed sources and rewritten in our format ([FORMAT.md](FORMAT.md)). Everything else from the harvest stays dormant and not yet rewritten in the catalog.

**Source root (temporary clones):** `C:\Users\Sunny\AppData\Local\Temp\claude\a88aa229a234b4a9\ea15e511-57ee-4b08-a305-34236f6768cf\scratchpad\repos\`
Folder names: `ruvnet__ruflo`, `affaan-m__ecc`, `msitarzewski__agency-agents`, `obra__superpowers`, `juliusbrussee__caveman`, `multica-ai__andrej-karpathy-skills`, `vercel-labs__agent-browser`, `vercel-labs__agent-skills`, `microsoft__playwright-mcp`.

Status: ☐ to do · ☑ written

## Batch 1 — Queen and managers (agents)

| Output | Sources |
|---|---|
| ☑ agents/queen | ruflo `.claude/agents/hive-mind/queen-coordinator.md`, `collective-intelligence-coordinator.md`; ecc `agents/planner.md`, `agents/chief-of-staff.md`; superpowers `skills/dispatching-parallel-agents/SKILL.md`, `skills/subagent-driven-development/SKILL.md`; spec `functions/02-hive.md` |
| ☑ agents/foreman | ruflo `.claude/agents/optimization/load-balancer.md`, `resource-allocator.md` (ideas only); ecc `agents/loop-operator.md`; spec 02 (taskboard, leases, auto-scaling) |
| ☑ agents/inspector | superpowers `skills/verification-before-completion/SKILL.md`; caveman `skills/verify-and-stop/SKILL.md`; agency `testing/testing-reality-checker.md`, `testing/testing-evidence-collector.md`; ecc `agents/agent-evaluator.md` |
| ☑ agents/treasurer | ruflo cost skills (ideas: `plugins/ruflo-cost-tracker/`), ecc `agents/harness-optimizer.md`; spec 02-D9 (model + effort router) |
| ☑ agents/librarian | ruflo `.claude/agents/hive-mind/swarm-memory-manager.md` (ideas); spec `functions/01-memory.md` (dedupe, consolidation, audits, health score, skill catalog upkeep 03-D6) |
| ☑ agents/watchdog | ecc `agents/loop-operator.md`; ruflo `.claude/agents/optimization/performance-monitor.md` (ideas); spec 02-D9 P3 (breaker ladder) |
| ☑ agents/scout | ruflo `.claude/agents/hive-mind/scout-explorer.md`; ecc `agents/code-explorer.md`; caveman `skills/caveman-explore/SKILL.md` (method only) |

## Batch 2 — Insect castes (agents)

| Output | Sources |
|---|---|
| ☑ agents/coder | agency `engineering/engineering-frontend-developer.md`, `engineering/engineering-backend-architect.md`; ecc `agents/build-error-resolver.md`; caveman `agents/cavecrew-builder.md` |
| ☑ agents/tester | ecc `agents/tdd-guide.md`, `agents/e2e-runner.md`; agency `testing/testing-test-automation-engineer.md`, `testing/testing-api-tester.md` |
| ☑ agents/reviewer | ecc `agents/code-reviewer.md`, `agents/security-reviewer.md`; agency `engineering/engineering-code-reviewer.md`; caveman `agents/cavecrew-reviewer.md` |
| ☑ agents/researcher | ecc `skills/deep-research/SKILL.md`, `skills/search-first/SKILL.md`; agency `product/product-trend-researcher.md`, `research/` folder |
| ☑ agents/documenter | agency `engineering/engineering-technical-writer.md`; ecc `agents/doc-updater.md`; agent-browser `.agents/skills/technical-writer/SKILL.md` |
| ☑ agents/designer | agency `design/design-ui-designer.md`, `design/design-ux-researcher.md`; ecc `skills/frontend-design-direction/SKILL.md` |
| ☑ agents/analyst | agency `support/support-analytics-reporter.md`, `finance/finance-financial-analyst.md`, `engineering/engineering-data-engineer.md` |
| ☑ agents/writer | agency `marketing/marketing-content-creator.md`, `marketing/marketing-email-strategist.md`, `marketing/marketing-seo-specialist.md`; vercel agent-skills `skills/writing-guidelines/SKILL.md` |

## Batch 3 — Planning, execution and hive workflow (skills)

| Output | Sources |
|---|---|
| ☑ skills/brainstorming | superpowers `skills/brainstorming/SKILL.md` |
| ☑ skills/writing-plans | superpowers `skills/writing-plans/SKILL.md`; ecc `agents/planner.md` — plans broken into task cards sized for one insect |
| ☑ skills/executing-a-task-card | superpowers `skills/executing-plans/SKILL.md`, `skills/subagent-driven-development/SKILL.md` — adapted for one insect working one card |
| ☑ skills/dispatching-parallel-work | superpowers `skills/dispatching-parallel-agents/SKILL.md` — for the Queen posting independent cards |
| ☑ skills/writing-skills | superpowers `skills/writing-skills/SKILL.md`; ecc `commands/skill-create.md` — for 03-D6 self-learning |
| ☑ skills/task-handoff | new, from spec 01 (E2 handoff checkpoints, E4 task briefs) |
| ☑ skills/using-the-brain | new, from spec 01 (tiered reading, what to write, trust levels D3, secrets guard) |

## Batch 4 — Quality (skills)

| Output | Sources |
|---|---|
| ☑ skills/test-driven-development | superpowers `skills/test-driven-development/SKILL.md`; ecc `skills/tdd-workflow/SKILL.md`, `agents/tdd-guide.md` |
| ☑ skills/systematic-debugging | superpowers `skills/systematic-debugging/SKILL.md`; caveman `skills/investigate-first/SKILL.md` |
| ☑ skills/verification-before-completion | superpowers `skills/verification-before-completion/SKILL.md`; caveman `skills/verify-and-stop/SKILL.md` |
| ☑ skills/code-review | ecc `agents/code-reviewer.md`; agency `engineering/engineering-code-reviewer.md`; superpowers `skills/requesting-code-review/SKILL.md`; caveman `skills/caveman-review/SKILL.md` |
| ☑ skills/receiving-review-feedback | superpowers `skills/receiving-code-review/SKILL.md` |
| ☑ skills/security-review | ecc `skills/security-review/SKILL.md`, `agents/security-reviewer.md` |
| ☑ skills/typescript-review | ecc `agents/typescript-reviewer.md`, `agents/react-reviewer.md` |
| ☑ skills/python-review | ecc `agents/python-reviewer.md`, `agents/fastapi-reviewer.md`, `agents/django-reviewer.md` |

## Batch 5 — Change discipline and git (skills)

| Output | Sources |
|---|---|
| ☑ skills/coding-discipline | karpathy `skills/karpathy-guidelines/SKILL.md`; ecc `skills/coding-standards/SKILL.md` (general rules only) |
| ☑ skills/surgical-patch | caveman `skills/surgical-patch/SKILL.md` |
| ☑ skills/safe-refactor | caveman `skills/safe-refactor/SKILL.md`; ecc `agents/refactor-cleaner.md` |
| ☑ skills/lean-build | caveman `skills/lean-build/SKILL.md` |
| ☑ skills/reversible-migration | caveman `skills/migration/SKILL.md`; ecc `skills/database-migrations/SKILL.md` |
| ☑ skills/git-workflow | ecc `skills/git-workflow/SKILL.md`; superpowers `skills/using-git-worktrees/SKILL.md`, `skills/finishing-a-development-branch/SKILL.md`; caveman `skills/caveman-commit/SKILL.md` |
| ☑ skills/build-error-resolution | ecc `agents/build-error-resolver.md`, `agents/react-build-resolver.md`, `agents/django-build-resolver.md` |

## Batch 6 — Token saving, research and docs (skills)

| Output | Sources |
|---|---|
| ☑ skills/compact-output | caveman `skills/caveman/SKILL.md`, `skills/ultracave/SKILL.md` — for agent-to-agent messages and reports; normal language for the user |
| ☑ skills/memory-compression | caveman `skills/caveman-compress/SKILL.md` — for Brain summaries and memory files |
| ☑ skills/deep-research | ecc `skills/deep-research/SKILL.md` |
| ☑ skills/search-first | ecc `skills/search-first/SKILL.md` |
| ☑ skills/technical-writing | agency `engineering/engineering-technical-writer.md`; agent-browser `.agents/skills/technical-writer/SKILL.md`; ecc `agents/doc-updater.md` |
| ☑ skills/writing-guidelines | vercel agent-skills `skills/writing-guidelines/SKILL.md` |

## Batch 7 — Browser, end-to-end testing and design (skills + tools)

| Output | Sources |
|---|---|
| ☑ tools/agent-browser | agent-browser `README.md`, `skills/agent-browser/SKILL.md` |
| ☑ tools/playwright-mcp | playwright-mcp `README.md` |
| ☑ skills/browser-automation | agent-browser `skill-data/core/SKILL.md`, `skills/agent-browser/SKILL.md` |
| ☑ skills/web-app-qa | agent-browser `skill-data/dogfood/SKILL.md`; ecc `skills/browser-qa/SKILL.md` |
| ☑ skills/e2e-testing | ecc `skills/e2e-testing/SKILL.md`, `agents/e2e-runner.md` |
| ☑ skills/web-design-guidelines | vercel agent-skills `skills/web-design-guidelines/SKILL.md`; ecc `skills/frontend-design-direction/SKILL.md` |
| ☑ skills/accessibility | ecc `skills/accessibility/SKILL.md`, `skills/frontend-a11y/SKILL.md` |

## Batch 8 — TypeScript / JavaScript (skills)

| Output | Sources |
|---|---|
| ☑ skills/typescript-patterns | ecc `skills/typescript-patterns/SKILL.md` |
| ☑ skills/react-patterns | ecc `skills/react-patterns/SKILL.md`; vercel `skills/composition-patterns/SKILL.md` |
| ☑ skills/react-performance | ecc `skills/react-performance/SKILL.md`; vercel `skills/react-best-practices/SKILL.md` |
| ☑ skills/react-testing | ecc `skills/react-testing/SKILL.md` |
| ☑ skills/frontend-patterns | ecc `skills/frontend-patterns/SKILL.md` |
| ☑ skills/backend-patterns | ecc `skills/backend-patterns/SKILL.md` |
| ☑ skills/api-design | ecc `skills/api-design/SKILL.md` |

## Batch 9 — Python, data and operations (skills)

| Output | Sources |
|---|---|
| ☑ skills/python-patterns | ecc `skills/python-patterns/SKILL.md` |
| ☑ skills/python-testing | ecc `skills/python-testing/SKILL.md` |
| ☑ skills/fastapi-patterns | ecc `skills/fastapi-patterns/SKILL.md` |
| ☑ skills/django-patterns | ecc `skills/django-patterns/SKILL.md`, `skills/django-security/SKILL.md` |
| ☑ skills/postgres-patterns | ecc `skills/postgres-patterns/SKILL.md` |
| ☑ skills/docker-patterns | ecc `skills/docker-patterns/SKILL.md` |
| ☑ skills/deployment-patterns | ecc `skills/deployment-patterns/SKILL.md` |
| ☑ skills/error-handling | ecc `skills/error-handling/SKILL.md` |

**Total: 15 agents, 48 skills, 2 tools = 65 items. All written 2026-11-12.**
