---
name: git-workflow
description: Version control for one task card - work in an isolated branch or worktree, write compact Conventional Commits, keep history clean, resolve conflicts, and finish the branch (merge locally, open a pull request, or keep). Pushing to shared repos and deleting branches or work need approval. Use whenever a task changes files in a git repository.
metadata:
  kind: skill
  castes: [coder, tester, documenter]
  tags: [git, branching, worktrees, commits, pull-requests]
  version: 1
  status: vetted
  sources:
    - repo: affaan-m/ecc
      path: skills/git-workflow/SKILL.md
      license: MIT
    - repo: obra/superpowers
      path: skills/using-git-worktrees/SKILL.md
      license: MIT
    - repo: obra/superpowers
      path: skills/finishing-a-development-branch/SKILL.md
      license: MIT
    - repo: juliusbrussee/caveman
      path: skills/caveman-commit/SKILL.md
      license: Apache-2.0
---

# Git Workflow

Isolate your work, commit it in small clear steps, and hand it back in a state someone else can integrate or undo.

Commands, a PR template and recovery recipes: [references/commands.md](references/commands.md).

## Approvals (hive rule 02-D7)

Set the card to blocked with an approval request (what, why, exact effect) and wait for the Queen's answer before you:
- **push** to any shared remote, open a pull request, or push tags;
- **merge into a branch others use** (main, develop, release branches); the user choosing "merge locally" when finishing counts as this approval;
- **delete** a branch, a worktree with uncommitted files, or any commits ("discard");
- **rewrite shared history** (force-push, rebase of pushed branches).

Everything else here (branching, committing, rebasing your own unpushed branch, local merges inside your workspace) needs no approval.

## 1. Isolate the work

One task card, one branch, one workspace.

1. **Check for existing isolation first.** The hive may have already given you a workspace (a worktree, a separate checkout, a sandbox). Compare `git rev-parse --git-dir` with `git rev-parse --git-common-dir`: if they differ (and `git rev-parse --show-superproject-working-tree` prints nothing, so it is not a submodule), you are already in a linked worktree. Don't create another.
2. **Prefer the harness's own workspace tool** if one exists. Creating worktrees behind its back leaves state it cannot see or clean up.
3. **Otherwise create a worktree yourself:**
   - Location: a configured worktree directory if one is declared; else an existing `.worktrees/` (preferred) or `worktrees/` in the project; else create `.worktrees/`.
   - Verify a project-local directory is git-ignored (`git check-ignore -q .worktrees`). If not, add it to `.gitignore` and commit that first, or the worktree's contents get committed.
   - `git worktree add .worktrees/<branch> -b <branch> <base>`
   - If creation is refused (sandbox, permissions), work in place on a new branch and say so.
4. **Set up and take a baseline.** Install dependencies with the project's normal command, then run the tests. If the baseline fails, record the failures and ask before proceeding: a dirty baseline makes every later failure ambiguous.

**Branch names:** `<type>/<short-description>`, e.g. `feat/order-export`, `fix/login-redirect-loop`, `refactor/extract-pricing`, `chore/bump-parser`. Include a ticket id if the project does (`fix/456-null-total`). Branch from the base named in the task card; if none is named, ask.

**Branching strategy:** follow the repository's. Most use short-lived branches off `main` merged by pull request; some use `develop` plus release branches. Keep branches short-lived (days, not weeks).

## 2. Commit

Small, focused commits, each leaving the code building. One logical change per commit.

**Stage deliberately.** Add specific files or hunks, not everything. Review `git diff --staged` before committing. Never commit secrets, `.env` files, credentials, build output, dependency folders or editor files.

**Message format (Conventional Commits):**

```
<type>(<scope>)!: <imperative summary>

<body: why, only if needed>

<footer: BREAKING CHANGE: ..., Closes #123>
```

- Types: `feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `chore`, `build`, `ci`, `style`, `revert`. Scope is optional.
- Imperative mood: "add", "fix", "remove", not "added" or "adds".
- Subject ≤ 50 characters when possible, hard cap 72, no trailing period. Match the project's capitalization.
- Skip the body when the subject says it all. Add one for a non-obvious *why*, breaking changes, migration notes or linked issues. Wrap at 72.
- **Always include a body** for breaking changes, security fixes, data migrations and reverts.
- Mark breaking changes with `!` and a `BREAKING CHANGE:` footer.
- Leave out: "this commit…", "I", "we", "now", restating file names the scope already gives, emoji (unless the project uses them).
- Attribution trailers (co-author, AI assistance): follow the project's or user's rule; don't invent one.

```
fix(api): retry upstream calls on 503

Upstream returns 503 under peak load; retry with backoff,
max 3 attempts.

Closes #123
```

## 3. Keep current and resolve conflicts

- **Your own, unpushed branch:** rebase onto the latest base to keep history linear (`git fetch`, then `git rebase origin/<base>`). Re-run tests after.
- **A branch that is pushed or shared:** merge the base in instead. Never rebase or force-push shared history without approval. If you must update your own pushed branch after an approved rebase, use `--force-with-lease`, never plain `--force`.
- **Never force-push** `main`, `develop` or any protected branch. Undo public commits with `git revert`.
- **Conflicts:** read both sides and understand why each changed before choosing. Keep both intents when both are valid. Remove all conflict markers, run the tests, then continue. If the conflict touches code outside your task's scope and the right answer isn't clear, stop and ask.
- Prevent conflicts: keep branches small and short-lived, sync with the base often.

## 4. Finish the branch

1. **Verify on the exact tree you will hand over.** Run the full test suite (and build/type checks). If anything fails, stop: report the failures; the options below come only after a green run.
2. **Confirm the base branch** this work forked from. If it isn't stated on the card or in the branch's upstream, ask. Merging into the wrong base is expensive to undo.
3. **Tidy local history** if it helps reviewers (squash "wip" and fix-up commits on your unpushed branch). Don't rewrite pushed history.
4. **Report and let the decision be made.** The integration choice belongs to the user (via the Queen) unless the task card already states it. Offer exactly:
   1. **Merge locally** into the base branch.
   2. **Push and open a pull request** (needs approval).
   3. **Keep the branch as-is** for later.
   From a detached HEAD, offer only 2 (pushed as a new branch) and 3.
5. **Carry out the chosen option.**
   - *Merge locally:* go to the main checkout, update the base, `git merge <branch>`, then run the tests on the merged result. If they fail, stop and leave the branch and worktree in place. If green, clean up (step 6) and delete the merged branch with `git branch -d` (safe delete).
   - *Pull request:* push with `-u`, open the PR with the forge's tooling following the repo's template, put the PR link in the task result. Keep the worktree: review fixes happen there.
   - *Keep:* report the branch name and worktree path.
6. **Clean up only what you created.** Remove the worktree from outside it (`git worktree remove <path>`, then `git worktree prune`). Only remove worktrees you created under the project's worktree directory; anything else belongs to the harness. If removal is refused because of modified or untracked files, never use `--force`: list the files and ask whether to commit them, move them, or delete them.

**Discarding work** happens only when explicitly requested. Before deleting, show exactly what will be lost (branch, commit list, worktree path) and get explicit confirmation of that list.

## Pull requests

- Title in commit format: `feat(auth): add SSO for enterprise users`.
- Body: what, why, how it was tested, linked issues. Use the repo's template if it has one.
- Keep it to one feature or fix; aim for under ~500 changed lines.
- Self-review the full diff before asking anyone else to.

## Red flags

- Committing directly to `main` or another shared branch.
- `git add .` without looking at what is staged.
- A rejected push "fixed" with force-push. A rejection means the remote moved: fetch and investigate.
- "Tests passed earlier" as proof for a tree that has changed since.
- Commit messages like "update", "fix", "wip" on work being handed over.
- Cleaning up a worktree or branch you did not create.

## Done when

- Work is committed on its own branch with clear messages, tests green on the final tree.
- The chosen finish option is carried out, or the decision is requested on the task card.
- The task result lists branch name, commits, worktree path or PR link, and any pending approvals.
