# Contributing to The Insectoids

Thank you for wanting to help. The Insectoids is early (v0.0.1), so your ideas, bug reports and code can shape it a lot.

## Ways to help

- **Use it and tell us.** Run it on a small project and open an issue: what you tried, what happened, what you expected.
- **Report bugs** with steps to reproduce, your OS, Node and Claude Code versions, and screenshots if the UI is involved.
- **Propose ideas** in an issue first for anything big, so we can agree on the approach before you write a lot of code. The design lives in [`functions/`](functions/README.md); changes to a decision there go through a short discussion and a change-log entry.
- **Pick up work.** Good areas right now:
  - macOS and Linux testing;
  - new engine adapters (Codex, Gemini CLI, OpenCode);
  - Brain meaning search;
  - accessibility;
  - library quality;
  - guard hardening.
- **Security problems** (for example a way past the command guard): please don't open a public issue. See [SECURITY.md](SECURITY.md).

## Set up

You need Node.js 24+, git, and Claude Code if you want real (non-scripted) runs.

```bash
corepack enable pnpm
```

```bash
pnpm install
```

```bash
pnpm dev
```

On Windows, if `corepack enable` fails with `EPERM`, see the note in the [README](README.md#run-it).

## Before you open a pull request

```bash
pnpm check
```

```bash
pnpm test:e2e
```

`pnpm check` runs lint, typecheck and the unit tests; `pnpm test:e2e` builds the app and drives it with Playwright. Both must pass. The e2e tests use a scripted engine, so they cost no tokens.

## How we work

- **Small, focused pull requests.** One change per PR, with a clear description of what and why.
- **Tests come with the change.** Core services (Brain, taskboard, workspace, guard) are built test-first: write the failing test, then the code. A bug fix includes a test that would have caught it.
- **Strict TypeScript.** The project uses `strict`, `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`. No `any` without a reason in a comment.
- **Typed boundaries.** Data crossing a process boundary (IPC, the Brain service, MCP) is validated with zod on both sides; contracts live in `packages/shared`.
- **UI:** use the existing design tokens and Tailwind classes. Prefer components from the libraries the project already uses (Kokonut UI, Cult UI, shadcn/ui) over hand-rolled ones, and note the source library in a comment at the top of the file. Status is never shown by colour alone; keyboard use and reduced motion must work.
- **Plain words.** Messages the user sees should be short and clear, and say what to do next.
- **Commits:** short imperative subject line ("Add X", "Fix Y"), with a body that explains why when it isn't obvious.

## Principles you can't trade away

These are what make The Insectoids trustworthy. Pull requests that weaken them won't be merged:

1. **The user's files change only with approval.** Agents work in their own worktrees; only the hive commits; merging into the user's branch needs approval.
2. **Undo stays possible.** Nothing is deleted: changes become versions, removals become archives, reverts keep history.
3. **The guard fails closed.** If a safety check can't run, the action is blocked.
4. **Local and private.** No telemetry, no uploads, no account. Agents never see keys or logins.
5. **The Brain has one writer.** Only the Brain service writes the database.
6. **Honest UI.** Show what really ran (model, effort, tokens, cost) and real status.

## Licensing

By contributing, you agree that your contribution is licensed under the project's [MIT license](LICENSE). If you add content adapted from another project, it must have a compatible license (MIT, Apache-2.0, BSD or similar). Credit it in [library/THIRD-PARTY-NOTICES.md](library/THIRD-PARTY-NOTICES.md), or in the file header for code, and include its license text.

## Be kind

Be respectful and constructive. Assume good intent, explain your reasoning, and help newcomers. Harassment or personal attacks aren't welcome here.
