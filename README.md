# The Insectoids

A local-first AI operating system modelled on a hive. A **Queen** turns your goals into task cards, **insect** agents of different castes pull and complete them in safe copies of your files, **manager** agents keep the hive fast and within budget, and everything they learn lives in one shared **Brain** on your own computer. It runs on the AI subscriptions you already have.

**Status:** Phase 0 (foundation). The hive itself arrives in Phase 1. See the [build roadmap](functions/10-build-roadmap.md).

## Where things are

| Folder | What's in it |
|---|---|
| [`functions/`](functions/README.md) | The design: one spec per function (Memory, Hive, Capabilities, Connections, Cadence, Workspace & Safety, App, Onboarding, Tech Stack, Roadmap) |
| [`design/`](design/) | UI prototype source and screenshots |
| [`library/`](library/) | Agents, skills and tools the hive uses (see [catalog](library/catalog/CATALOG.md)) |
| `apps/desktop/` | The Electron app (main process, preload bridge, React UI) |
| `packages/shared/` | Types and rules shared by every process |

## Develop

Requires Node.js 24+. pnpm is pinned in `package.json` and provided by Corepack:

```bash
corepack enable pnpm
```

```bash
pnpm install
```

```bash
pnpm dev
```

Checks:

```bash
pnpm check
```

```bash
pnpm test:e2e
```

`pnpm check` runs lint, typecheck and unit tests. `pnpm test:e2e` builds the app and drives it with Playwright.

## Privacy

The Brain stays on your computer and nothing is uploaded. There is no telemetry. Agents never see your API keys. Fonts are bundled, so the app makes no hidden network calls.

## License

[MIT](LICENSE). Parts of `library/` are adapted from MIT and Apache-2.0 projects; see [library/THIRD-PARTY-NOTICES.md](library/THIRD-PARTY-NOTICES.md).
