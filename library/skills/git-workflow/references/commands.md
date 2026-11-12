# Git Commands and Templates

Quick reference for the `git-workflow` skill. Steps marked **(approval)** need user approval through the Queen before running (02-D7).

## Isolation

```bash
# Am I already in a linked worktree?
git rev-parse --git-dir          # differs from --git-common-dir => linked worktree
git rev-parse --git-common-dir
git rev-parse --show-superproject-working-tree   # prints a path => submodule, not a worktree
git branch --show-current        # empty => detached HEAD

# Create a worktree on a new branch
git check-ignore -q .worktrees || echo "not ignored: add to .gitignore first"
git worktree add .worktrees/feat-order-export -b feat/order-export origin/main

git worktree list
```

## Everyday

| Task | Command |
|---|---|
| New branch from base | `git switch -c feat/name origin/main` |
| See changes | `git status`, `git diff`, `git diff --staged` |
| Stage specific hunks | `git add -p <file>` |
| Commit | `git commit` (message per the skill's format) |
| History | `git log --oneline --graph` |
| Park unfinished work | `git stash push -m "wip: short note"`, then `git stash pop` |
| Update own unpushed branch | `git fetch origin && git rebase origin/main` |
| Update shared branch | `git fetch origin && git merge origin/main` |

## Conflicts

```bash
git status                       # lists conflicted files
# edit each file: keep the right content, remove <<<<<<< ======= >>>>>>> markers
git add <file>
git rebase --continue            # or: git commit (for a merge)
git rebase --abort               # back out of a rebase entirely
git merge --abort                # back out of a merge entirely
```

`git checkout --ours <file>` / `--theirs <file>` take one side wholesale. Note that during a rebase "ours" is the base you are rebasing onto, and "theirs" is your commit.

Dry-run a merge without committing: `git merge --no-commit --no-ff <branch>`, inspect, then `git merge --abort`.

## Finishing

```bash
# Merge locally (from the main checkout, not inside the worktree)
git switch main
git pull                         # update base
git merge feat/order-export
<run tests on merged result>
git branch -d feat/order-export  # safe delete; refuses if unmerged

# Push and open a PR  (approval)
git push -u origin feat/order-export
# from a detached HEAD:  git push origin HEAD:refs/heads/<new-branch>

# Remove a worktree you created (run from outside it)
git worktree remove .worktrees/feat-order-export
git worktree prune
git -C <worktree> status --porcelain -uall   # if removal is refused: what would be lost
```

## Undoing mistakes

| Situation | Command | Safe? |
|---|---|---|
| Undo last local commit, keep changes | `git reset --soft HEAD~1` | Yes (unpushed only) |
| Fix last local commit message | `git commit --amend` | Unpushed only |
| Add forgotten file to last local commit | `git add <file> && git commit --amend --no-edit` | Unpushed only |
| Undo a pushed commit | `git revert <sha>` (new commit) | Yes |
| Restore one file to last commit | `git restore <file>` | Discards your edits to that file |
| Throw away local commits and changes | `git reset --hard <ref>` | Destroys work: **(approval)** |
| Force-delete an unmerged branch | `git branch -D <branch>` | Destroys commits: **(approval)** |
| Update own pushed branch after rebase | `git push --force-with-lease` | **(approval)** |
| Delete a remote branch or tag | `git push origin --delete <name>` | **(approval)** |

Lost a commit? `git reflog` lists recent HEAD positions; recover with `git switch -c rescue <sha>`.

## Releases (only when the task asks)

Semantic versioning: `MAJOR.MINOR.PATCH` (breaking / feature / fix).

```bash
git tag -a v1.2.0 -m "Release v1.2.0"     # annotated tag, local
git push origin v1.2.0                    # (approval)
git log v1.1.0..v1.2.0 --oneline --no-merges   # raw material for a changelog
```

## Pull request description template

Use the repository's own template if it has one. Otherwise:

```markdown
## What
One or two sentences on what changes.

## Why
The problem or task card this addresses.

## How
Key implementation choices worth a reviewer's attention.

## Testing
- Tests added/updated: ...
- Checks run: tests, type check, lint, build (all passing)

## Notes
Breaking changes, migrations, follow-ups.

Closes #123
```

Author checklist before requesting review: self-reviewed the full diff; CI-equivalent checks pass locally; one feature or fix; no stray debug output, secrets or generated files; docs updated if behaviour changed.

## Ignore file basics

Never commit: dependency folders (`node_modules/`, `vendor/`, virtualenvs), build output (`dist/`, `build/`), environment files (`.env`, `.env.*`), logs, coverage output, caches, editor and OS files. Check the project's `.gitignore` covers them before your first commit.
