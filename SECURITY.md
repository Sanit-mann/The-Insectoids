# Security

The Insectoids lets AI agents run commands on your computer, so safety matters more than anything else in this project.

## Reporting a problem

If you find a way to get past the command guard, read protected files, write outside a card's workspace, change the user's branch without approval, leak a key or login, or anything similar, **please report it privately**. Don't open a public issue.

- Use GitHub's private reporting: the **Security** tab of this repository → **Report a vulnerability**.
- Include the exact command or steps, what happened, and what you expected. A failing test case is ideal.

We'll acknowledge your report, work on a fix, and credit you in the release notes unless you'd rather stay anonymous.

## What the guard is, and isn't

The command guard (`packages/reflexes`) checks every shell command and file action an agent tries, before it runs, and fails closed. It is one strong layer, **not a sandbox**: code an agent writes and then runs (for example a test script) runs with your user's rights. Use a separate machine or VM for projects you don't trust until the container sandbox mode (planned for Phase 4) exists.

## Supported versions

Only the latest release receives fixes during the 0.x developer previews.
