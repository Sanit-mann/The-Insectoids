# Engine CLIs: facts for safe presets

Date: 2026-11-15. Every source below was read on 2026-11-15 unless a line says otherwise.

Purpose: The Insectoids runs AI coding CLIs as headless workers. Before we write a "preset" for a CLI, we need to know four things. Can we run it without a person? Can we read its output as JSON? Can we turn off its own file-edit and shell tools, or limit them? Which flags remove every guard? This file holds what the official docs, READMEs, release notes and package registries say. Where they say nothing, it says "unknown".

How to read it:
- Numbers in square brackets, like [1], point to the source list at the end of each section.
- "Never pass alone" lists flags that approve everything. The hive must never pass them unless the worker already runs inside a sandbox or container that the hive controls.
- Version numbers and dates come from `npm view` (npm registry) or the GitHub releases page, both checked on 2026-11-15.
- On this PC, `command -v copilot` finds only VS Code's `copilot-shim`. Running `copilot --version` prints "GitHub Copilot CLI was not found". So the real Copilot CLI is not installed, and nothing here was checked against a local binary. None of the other CLIs are installed (`codex`, `agent`/`cursor-agent`, `qwen`, `grok`, `kimi`, `crush`, `pi` and `agy` were all not found).

---

## 1. GitHub Copilot CLI (`copilot`)

**Checked on this PC in Phase 4 B2 (2026-11-15, Copilot CLI 1.0.105)**, first offline (its documented BYOK mode: `COPILOT_OFFLINE=true` + `COPILOT_PROVIDER_BASE_URL` pointed at a local fake model, no account, nothing spent), then with one real signed-in run the user approved. These replace the unknowns below:
- Events (`--output-format json`): `assistant.message` (whole text, `data.content`), `assistant.message_delta`, `tool.execution_start` / `tool.execution_complete` (`toolName`, `toolCallId`, `arguments`), `session.error` (`errorType`, `message`), and a last `result` line with `exitCode`, `sessionId` and `usage.premiumRequests`. No token counts in the stream: `--usage-output-file <file>` writes them per model (`modelMetrics.<model>.usage`). Its `inputTokens` already include cache reads and writes.
- Built-in tool names: `powershell` (plus `read_/stop_/list_powershell`), `view`, `create`, `edit`, `grep`, `glob`, `task`, `skill`, `sql`, `session_store_sql`, `read_agent`, `list_agents`, `write_agent`, `run_dynamic_workflow`, `dynamic_workflows_manage`, `fetch_copilot_cli_documentation`. MCP tools are named `<server>-<tool>`.
- `--available-tools` takes exact names only (no wildcards, no server name), comma-separated; a name that matches nothing leaves the model no tools at all. A hidden tool the model calls anyway fails with "does not exist". Headless (with `-p` or a stdin prompt), a visible but unapproved tool is denied. Deny rules beat every allow.
- The MCP config's `cwd` and `env` are honoured per server; `--additional-mcp-config=@file` adds servers for one run.
- A bad or missing sign-in prints plain text on stderr and exits 1 before any JSON ("Authentication token found but could not be validated", "/login").
- `--model=auto` refuses `--reasoning-effort` ("Model "auto" does not support reasoning effort configuration"); `--auto-tier=efficiency` was accepted. The real run: Auto (efficiency) picked `gpt-6-luna`, answered in 1.4 s, 2,965 input tokens (2,962 of them cache writes) and 5 output, 1 premium request.
- No sign-in status command was found (`copilot login` has none); sign-in problems show on the first run.
- VS Code puts its own `copilot` stand-in (`…\Microsoft VS Code\bin\copilot-shim\copilot.exe`) on PATH ahead of npm's; it isn't the CLI. npm's `copilot.cmd` runs `npm-loader.js`, which only starts the native `copilot.exe` from `@github/copilot-<platform>-<arch>`.

**Install, version, licence**
- Install: `npm install -g @github/copilot` (needs Node 22+), `winget install GitHub.Copilot`, `brew install --cask copilot-cli`, or the script `curl -fsSL https://gh.io/copilot-install | bash` [1]. You need an active Copilot subscription [1].
- Current version: 1.0.112, published to npm on 2026-11-13 [2][3].
- Licence: npm says "SEE LICENSE IN LICENSE.md", which is a GitHub licence and not an open-source one [2].

**Headless run and JSON**
- `copilot -p "<prompt>"` runs one prompt and exits. It exits non-zero if the run is interrupted [4]. Piped stdin also works (`echo "..." | copilot`), but piped input is ignored when `-p` is given [5]. `--attachment=PATH` adds files in non-interactive mode [6].
- `--output-format json` prints JSONL, one object per line [4]. The docs we read do not name the event types for `-p` runs. They only name `workflow.result`, the last record of `copilot workflow run` [6]. **Unknown:** the event schema, and where tokens and premium requests appear in JSONL. `-s/--silent` prints only the agent reply, with no usage statistics [7].
- Other flags for unattended runs: `--no-ask-user` (no clarifying questions), `--no-auto-update` or `COPILOT_AUTO_UPDATE=false`, and `--secret-env-vars` [6].

**Model**
- Set it with `--model=MODEL` or `COPILOT_MODEL`. `auto` lets Copilot choose [4][7]. The docs name `claude-sonnet-5.5` as the default [7]. The supported-models page lists Claude Haiku 4.5/5.5, Claude Opus 4.8, GPT-5.6 Sol, GPT-6 Sol and Gemini 3.8 Flash, among others, for Copilot CLI. Which plan gets which model was not visible in what we read [8].

**Sign-in**
- `copilot login` (OAuth device flow by default, `--web-flow`, `--device-code`, `--with-token`, `--host`) or `/login` inside the CLI [4][9]. Token environment variables, in order of precedence: `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN` [4].
- Status check: there is no documented standalone status command. Inside a session, `/user` (`/user show|list|switch`) shows the signed-in account [9]. **Unknown:** a headless status check. The hive can treat the first `-p` run failing with "No authentication information found" as "not signed in" [9].

**Tool control (most important)**
- `--available-tools` means only these tools exist for the model. `--excluded-tools` removes tools from the model [7].
- `--allow-tool` and `--deny-tool` take patterns like `Kind(argument)`, for example `shell(git:*)` or `write` [7][5]. "Deny rules always take precedence over allow rules, even when `--allow-all` is set." [7]
- In non-interactive runs, "requests that still require your approval are denied" [6]. So a `-p` run with no allow flags cannot edit files or run shell commands without approval. This is a safe default.
- `--assisted-approval` routes approvals through a model review. It does not restrict paths or URLs [6].
- MCP: servers live in `~/.copilot/mcp-config.json`. `--additional-mcp-config` adds servers for one run and has the highest priority. `--disable-builtin-mcps` turns off the built-in `github-mcp-server`, `WorkIQ`, `browser-use` and others, but not `computer-use` [7]. Workspace MCP servers load only in trusted folders. `--trust-folder` trusts the folder's hooks, MCP servers and plugins for one run [6].
- Per-run config dir: `COPILOT_HOME` replaces the whole `~/.copilot` path. `--config-dir` is legacy [10].
- **Never pass alone:** `--allow-all-tools`, `--allow-all` / `--yolo`, `--allow-all-paths`, `--allow-all-urls`, and the env var `COPILOT_ALLOW_ALL` [6][7]. Be careful with `--trust-folder` and `--share-gist` (which uploads the transcript) [6].

**Logs, sessions, telemetry**
- `~/.copilot/logs/process-{timestamp}-{pid}.log`, which `--log-dir` can change. Sessions live in `~/.copilot/session-state/<id>/events.jsonl`. Saved approvals are in `permissions-config.json`. Auth state is in `config.json` or the OS keychain [10][4].
- `--disable-client-telemetry` turns off CLI telemetry but not server-side telemetry [4]. OpenTelemetry is off unless `COPILOT_OTEL_ENABLED`, `OTEL_EXPORTER_OTLP_ENDPOINT` or `COPILOT_OTEL_FILE_EXPORTER_PATH` is set [11]. Synced sessions on GitHub are stored separately [10].

**Exit codes and errors**
- For `-p`, the docs only say it exits non-zero if interrupted [4]. Only `copilot workflow run` has a table: 0 done, 1 not completed or error, 2 bad workflow or args, 130 SIGINT/SIGTERM. Its errors go to stderr [6]. **Unknown:** a full exit-code table for `-p`.

**Can the hive guard it? Yes.** Pass `--available-tools` (or `--excluded-tools`) to remove shell and write tools. Add `--deny-tool` for extra safety. Rely on non-interactive auto-deny. Set a per-run `COPILOT_HOME`, give the hive's MCP servers with `--additional-mcp-config`, and pass `--disable-builtin-mcps`, `--no-ask-user` and `--disable-client-telemetry`. Open item: the exact tool names that `--available-tools` takes were not in the pages we read. Check `copilot help permissions` once the real CLI is installed.

Sources:
1. https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli (2026-11-15)
2. npm registry, `npm view @github/copilot` (2026-11-15)
3. https://github.com/github/copilot-cli/releases (2026-11-15)
4. https://docs.github.com/en/copilot/reference/cli-command-reference (2026-11-15)
5. https://docs.github.com/en/copilot/how-tos/copilot-cli/automate-copilot-cli/run-cli-programmatically (2026-11-15)
6. https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference (2026-11-15)
7. https://docs.github.com/en/copilot/reference/cli-command-reference (sections on command-line options and permissions, read at offsets 200k–400k, 2026-11-15)
8. https://docs.github.com/en/copilot/reference/ai-models/supported-models (2026-11-15)
9. https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli and the troubleshooting page (from search results, 2026-11-15)
10. https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference (2026-11-15)
11. https://docs.github.com/en/copilot/reference/cli-command-reference (OTel section, 2026-11-15)

---

## 2. OpenAI Codex CLI (`codex`)

**Checked on this PC in Phase 4 B3 (2026-11-15, Codex CLI 0.166.0)**, offline only: a custom model provider (`-c model_provider=… model_providers.<id>.base_url=… wire_api="responses"`) pointed at a local fake Responses API, no ChatGPT account, nothing spent. The user has no ChatGPT plan, so no signed-in run was done. These replace the unknowns below:
- `codex exec` reads the prompt from stdin when no prompt argument is given. `--json` events seen: `thread.started`, `turn.started`, `item.started` / `item.completed` (`agent_message` with `text`; `mcp_tool_call` with `server`, `tool`, `arguments`, `result`, `error`, `status`; `error` items for warnings), `turn.completed` with `usage` (`input_tokens` include `cached_input_tokens`; also `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens`), `turn.failed`, and top-level `error` (including "Reconnecting... n/5" retries). Exit 0 after `turn.completed`, 1 after `turn.failed`.
- Default tools offered to the model: `exec_command`, `write_stdin`, `request_user_input`, `view_image`, `multi_agent_v1`, `get_goal` / `create_goal` / `update_goal`, `web_search`. With `--disable shell_tool --disable unified_exec --disable multi_agent --disable goals --disable view_image` and `-c web_search="disabled"`, only `list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource`, `request_user_input` and the MCP servers remain. Calls to `exec_command`, `shell` or `apply_patch` then come back "unsupported call".
- MCP servers are offered as a `namespace` (`mcp__<server>`) holding the tools; a call names the namespace separately. With `approval_policy="never"` an MCP call fails ("requires approval, but approval policy is never") unless the server has `default_tools_approval_mode="approve"`. `command`, `args`, `cwd`, `required` and `env_vars` (names passed through from Codex's own environment) all work by `-c`; `--strict-config` accepted all of them.
- `--ignore-user-config` skips `$CODEX_HOME/config.toml` while sign-in still uses `CODEX_HOME`. `codex login status` prints "Not logged in" and exits 1 when signed out. Signed out, a run gets HTTP 401 from OpenAI (retried 5 times over WebSocket, then 5 over HTTPS) and ends in `turn.failed`.
- npm's `codex.cmd` runs `bin/codex.js`, which only sets `CODEX_MANAGED_BY_NPM` / `CODEX_MANAGED_PACKAGE_ROOT` (update hints) and starts `@openai/codex-<platform>-<arch>/vendor/<target triple>/bin/codex.exe`. The Windows package is about 503 MB.

**Install, version, licence**
- `npm install -g @openai/codex`, `brew install --cask codex`, or the scripts `curl -fsSL https://chatgpt.com/codex/install.sh | sh` and, on Windows, `irm https://chatgpt.com/codex/install.ps1 | iex` [1].
- Version 0.169.0, published to npm on 2026-11-13 [2][3]. Licence: Apache-2.0 [1][2].
- Note: the developers.openai.com Codex docs now redirect (HTTP 308) to learn.chatgpt.com. We read the redirect targets.

**Headless run and JSON**
- `codex exec "<task>"`. `codex exec -` reads the whole prompt from stdin. Piped stdin plus a prompt argument means the stdin is extra context. Progress goes to stderr, and only the final message goes to stdout [4].
- `--json` turns stdout into JSONL. Event types are `thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.*` and `error`. Items include agent messages, reasoning, command runs, file changes, MCP tool calls, web searches and plan updates. `turn.completed` carries `usage` with `input_tokens`, `cached_input_tokens`, `output_tokens` and `reasoning_output_tokens` [4]. `-o/--output-last-message <file>` saves the final message, and `--output-schema <file>` asks for JSON matching a schema [4]. Cost is not reported (unknown).
- `--ephemeral` stops session files being written to disk. `--skip-git-repo-check` is needed outside a git repo [4].

**Model**
- `-m/--model`, `codex exec -m <model>`, or `model = "..."` in `config.toml` [5]. Recommended with ChatGPT sign-in: `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6.1-terra` and `gpt-6-luna`. Plus, Pro, Business, Enterprise and Edu users are pointed to `gpt-6.1-sol`, and Free and Go users to `gpt-6-luna` [5]. Reasoning is set with `model_reasoning_effort` (low … ultra, depending on the model) [6].

**Sign-in**
- `codex login` supports ChatGPT OAuth, device auth, an API key, or a token piped on stdin. `codex logout` removes credentials [7][8]. For one run, `CODEX_API_KEY` can be set inline [4].
- Status: `codex login status` "exits with `0` when credentials are present" [8].

**Tool control (most important)**
- Sandbox: `--sandbox read-only` (the default for `exec`), `workspace-write`, or `danger-full-access` [4][6]. `approval_policy` can be `on-request`, `never` or a `granular` table [6]. Permission profiles (`permissions.<name>`) can mark paths as read, write or deny and limit network domains [6].
- The shell tool can be turned off: `features.shell_tool` (on by default) enables the command tools [6]. So `-c features.shell_tool=false` per run should remove it. Not tested here. **Unknown:** a documented switch that turns off the file-edit (`apply_patch`) tool. A read-only sandbox blocks writes instead.
- Web search is controlled by the top-level `web_search` / `tools.web_search` setting [6].
- MCP: `[mcp_servers.<id>]` in `config.toml`, with `command`/`args`/`env` (stdio) or `url` (streamable HTTP), plus `enabled_tools`, `disabled_tools`, `required` and `startup_timeout_sec` [6]. A project `.codex/config.toml` loads only for trusted projects [9]. If a `required` server fails to start, `exec` exits with an error [4].
- Per-run config: `CODEX_HOME` moves the whole `.codex` directory (the default on Windows is `%USERPROFILE%\.codex`) [9][10]. `--ignore-user-config` skips `$CODEX_HOME/config.toml`, `--ignore-rules` skips execpolicy rule files, and `-c key=value` overrides one key [4][8].
- Windows: there is a native sandbox. `[windows] sandbox = "elevated"` is preferred, with `"unelevated"` as the fallback [10].
- **Never pass alone:** `--dangerously-bypass-approvals-and-sandbox` (alias `--yolo`) and `--sandbox danger-full-access` [8][11]. Be careful with `--approve-for-me`, which sends approvals to automatic review [4]. `--full-auto` is no longer supported [4].

**Logs, sessions, telemetry**
- Logs go to `log_dir`, by default `$CODEX_HOME/log` [6]. Transcripts go to `history.jsonl`, and `history.persistence = "none"` turns that off [6]. Session "rollout" files are written to disk unless `--ephemeral` is given [4]. The exact subfolder is not confirmed by the pages we read.
- Telemetry: `analytics.enabled = false` turns off the built-in Statsig metrics. `otel.exporter`, `otel.trace_exporter` and `otel.metrics_exporter` take `none`, `otlp-http` or `otlp-grpc` [6].

**Exit codes and errors**
- Errors appear as `turn.failed` or `error` events in `--json` [4]. Documented non-zero exits: a failed `codex apply`, a failed `codex cloud exec`, and a required MCP server failing to start [4][8]. **Unknown:** a numbered exit-code table for `exec`.

**Can the hive guard it? Yes.** Use `codex exec --json --sandbox read-only` (or `workspace-write` for workers that must edit) with `-c features.shell_tool=false` when no shell is wanted. Give it a per-run `CODEX_HOME` holding the hive's `config.toml` and `[mcp_servers]`, set `analytics.enabled=false`, and check sign-in with `codex login status`. This is the strongest guard of the nine, because the sandbox is enforced by the operating system.

Sources:
1. https://github.com/openai/codex (README, 2026-11-15)
2. npm registry, `npm view @openai/codex` (2026-11-15)
3. https://github.com/openai/codex/releases (2026-11-15)
4. https://learn.chatgpt.com/docs/non-interactive-mode (redirect target of developers.openai.com/codex/noninteractive, 2026-11-15)
5. https://learn.chatgpt.com/docs/models (2026-11-15)
6. https://learn.chatgpt.com/docs/config-file/config-reference (redirect target of developers.openai.com/codex/config-reference, 2026-11-15)
7. https://developers.openai.com/codex/cli/reference (search-result snippet, 2026-11-15)
8. https://learn.chatgpt.com/docs/developer-commands.md?surface=cli (2026-11-15)
9. https://developers.openai.com/codex/mcp and search results on CODEX_HOME (2026-11-15)
10. https://learn.chatgpt.com/codex/windows/windows-sandbox and https://developers.openai.com/codex/app/windows.md (search results, 2026-11-15)
11. https://developers.openai.com/codex/cli/reference (search snippet: "should be used only in an externally hardened environment", 2026-11-15)

---

## 3. Cursor agent CLI (`agent`, formerly `cursor-agent`)

**Install, version, licence**
- macOS, Linux and WSL: `curl https://cursor.com/install -fsS | bash`. Windows: `irm 'https://cursor.com/install?win32=true' | iex`. It auto-updates by default, and `agent update` updates by hand [1].
- Binary: `agent`. Since the CLI release of 2026-01-08, `cursor-agent` still works as an alias [2].
- Current version and date: **unknown**. The docs only say to run `agent --version`. The cursor.com changelog's five latest entries (to 2026-11-06) are not CLI releases [3]. Licence: **unknown** (none is published on the pages we read).

**Headless run and JSON**
- `agent -p "<prompt>"` (`--print`). `--output-format text|json|stream-json` works only with `--print`. `--stream-partial-output` streams text deltas [4].
- `json` gives one object at the end with `type`, `subtype`, `is_error`, `duration_ms`, `duration_api_ms`, `result`, `session_id` and `request_id` [5].
- `stream-json` is NDJSON with these events: `system`/`init` (it carries the `model` and `permissionMode`), `user`, `assistant`, `tool_call`/`started`, `tool_call`/`completed`, and `result`/`success` [5].
- Tokens and cost are **not documented**. The model appears only in the `init` event [5].

**Model**
- `--model <model>`. `agent models` lists the models for your account [4]. **Unknown:** the model names on a normal plan.

**Sign-in**
- `agent login` and `agent logout`. For scripts, use `--api-key` or `CURSOR_API_KEY` [4].
- Status: `agent status` (alias `whoami`) [4].
- `AGENT_CLI_CREDENTIAL_STORE=file` stores credentials in an owner-only file instead of the keychain [2].

**Tool control (most important)**
- **Watch out:** "Print mode writes to files in your workspace even without `--force`." Writes outside the workspace and to `.vscode/` or `.git/hooks/` are rejected. Shell commands run only if they are on the allowlist or can run in the sandbox. Other shell commands are rejected [6].
- `--mode ask` is "Read-only exploration without making changes". `--mode plan` is for planning, and the docs do not call it read-only [7]. The docs do not say whether ask mode also blocks shell.
- Permissions: `permissions.allow` / `permissions.deny` in `~/.cursor/cli-config.json` (on Windows, `%USERPROFILE%\.cursor\cli-config.json`) or `<project>/.cursor/cli.json`. Rule tokens are `Shell(cmd)`, `Read(glob)`, `Write(glob)`, `WebFetch(domain)` and `Mcp(server:tool)`. Deny beats allow [8]. The docs show no example that blocks all writes or all shell. `Write(**)` probably works but is not tested.
- `approvalMode` can be `allowlist`, `auto-review` or `unrestricted`. Sandbox settings are `sandbox.mode`, `sandbox.networkAccess` and `sandbox.readBoundary` (`system` or `workspace`) [9]. The `--sandbox enabled|disabled` flag also exists [4].
- Per-run config dir: `CURSOR_CONFIG_DIR` [9].
- MCP: the CLI uses the same `mcp.json` as the editor (project `.cursor/mcp.json`, global `~/.cursor/mcp.json`, and parent folders are also discovered). There is no flag for a custom MCP file [10][2]. `agent mcp list|list-tools|enable|disable|login` [10].
- **Never pass alone:** `-f/--force` and `--yolo` ("Force allow commands unless explicitly denied"), `--approve-mcps`, `approvalMode: "unrestricted"` (which makes print mode act like `--force`), and `--sandbox disabled` [4][6][9]. Be careful with `--trust`, which trusts the workspace without asking [4].

**Logs, sessions, telemetry**
- **Unknown** in the official docs. Forum posts (not official) say transcripts are under `~/.cursor/projects/.../agent-transcripts/` [11]. No CLI telemetry switch is documented. Privacy Mode is an account setting.

**Exit codes and errors**
- On failure the CLI exits non-zero and writes the error to stderr. `json` then prints no object, and `stream-json` may end without a `result` event [5]. No numbered codes are documented.

**Can the hive guard it? Partly.** Use `--mode ask` for read-only workers. For other workers, set a per-run `CURSOR_CONFIG_DIR` whose `cli-config.json` has `approvalMode: "allowlist"`, a deny list (`Write(**)`, `Shell(...)`) and the sandbox on. Weak points: print mode can edit workspace files by default, the MCP config cannot be set per run (the project's `.cursor/mcp.json` is read), and there is no token or cost data.

Sources:
1. https://cursor.com/docs/cli/installation (2026-11-15)
2. Cursor changelog "CLI Jan 08 2026" and the Cursor changelog search results (https://cursor.com/changelog, search 2026-11-15)
3. https://cursor.com/changelog (2026-11-15)
4. https://cursor.com/docs/cli/reference/parameters (2026-11-15)
5. https://cursor.com/docs/cli/reference/output-format (2026-11-15)
6. https://cursor.com/docs/cli/headless (2026-11-15)
7. https://cursor.com/docs/cli/overview (2026-11-15)
8. https://cursor.com/docs/cli/reference/permissions (2026-11-15)
9. https://cursor.com/docs/cli/reference/configuration (2026-11-15)
10. https://cursor.com/docs/cli/mcp (2026-11-15)
11. forum.cursor.com threads (unofficial; search 2026-11-15)

---

## 4. Qwen Code (`qwen`)

**Install, version, licence**
- `npm install -g @qwen-code/qwen-code@latest` (needs Node 22+), `brew install qwen-code`, or standalone scripts hosted on `qwen-code-assets.oss-cn-hangzhou.aliyuncs.com` [1].
- Version 0.27.4, published to npm on 2026-11-15 [2][3]. Licence: Apache-2.0 [1].

**Headless run and JSON**
- `qwen -p "<prompt>"`. Piped stdin also works (`cat README.md | qwen -p "..."`) [4].
- `-o/--output-format text|json|stream-json`. `json` is an array of messages. `stream-json` is one object per line. `--include-partial-messages` adds `message_start` and `content_block_delta` [4].
- Events are `system`/`session_start` (with `session_id` and `model`), `assistant` (with model and usage), `result` (with `subtype`, `is_error`, `duration_ms`, `result` and `usage`), and `stream_event`. Successful JSON output adds `stats.models` (tokens per model) and `stats.tools.totalCalls`. Cost is not given [4].

**Model**
- `-m/--model` or `model.name` [5]. The Coding Plan lists qwen3.5-plus, qwen3.6-plus, qwen3.7-plus, qwen3-coder-plus, qwen3-coder-next, glm-5, kimi-k2.5 and others. The models for "Qwen Account with Subscription" (OAuth) are not listed [6].

**Sign-in**
- `/auth` inside the app. Choices are a Qwen account with a Plus or Pro subscription (browser OAuth), QwenCloud, Alibaba ModelStudio, third-party providers, or a custom endpoint [6]. "OAuth cannot be configured with env vars alone", so headless CI must use an API key [6].
- Status: `qwen auth` was removed. Use `/doctor` inside the app [6]. **Unknown:** a headless status command.

**Tool control (most important)**
- `permissions.allow` / `ask` / `deny` in settings, as `ToolName` or `ToolName(specifier)`. Deny beats ask, and ask beats allow. Aliases are `Bash`/`Shell`, `Edit`, `Write`/`WriteFile` and `Read` [5]. Older keys (`tools.core`, `tools.exclude`, `tools.allowed`) are deprecated [5].
- `--approval-mode plan|default|auto-edit|auto|yolo`. **Watch out:** the settings key `tools.approvalMode` defaults to `auto`, a classifier-driven mode [5][1]. The docs do not say what headless runs do with calls that need approval under `default` (unknown).
- MCP: `mcpServers.<name>` with `command`/`args`/`env`/`cwd`/`url`/`httpUrl`/`headers`/`trust`/`includeTools`/`excludeTools`. `mcp.allowed` and `mcp.excluded` filter servers [5].
- Config files are `~/.qwen/settings.json`, project `.qwen/settings.json`, and a system file. `QWEN_HOME` moves the global dir and `QWEN_RUNTIME_DIR` moves runtime output [5].
- Sandbox: `-s/--sandbox` [5].
- **Never pass alone:** `--yolo` and `--approval-mode yolo` ("auto-approve every tool call, including `shell`, `write`, and `edit`") [4]. Treat `auto` and `auto-edit` as unsafe too. Also never set `trust: true` on an MCP server.

**Logs, sessions, telemetry**
- Session records, logs and todos go to `QWEN_RUNTIME_DIR`, then `QWEN_HOME`, then `~/.qwen`. Shell history goes to `~/.qwen/tmp/<project_hash>/shell_history` [5].
- Usage statistics are **on by default**. Turn them off with `privacy.usageStatisticsEnabled: false` or `QWEN_USAGE_STATISTICS_ENABLED=false`. OTel telemetry is controlled by `telemetry.enabled` and `QWEN_TELEMETRY_ENABLED`, and `telemetry.logPrompts` controls whether prompts are logged [5].

**Exit codes and errors**
- 53 means the turn cap was exceeded, 55 means the budget was exceeded, and 130 means SIGINT. JSON results carry `is_error`. Retries for 429/529 print to stderr [4]. Other codes are unknown.

**Can the hive guard it? Yes.** Set a per-run `QWEN_HOME` whose `settings.json` holds `permissions.deny: ["Bash", "Edit", "Write"]` (or narrower rules), `tools.approvalMode: "default"` or `plan`, `privacy.usageStatisticsEnabled: false`, and the hive's `mcpServers`. Always pass `--approval-mode` explicitly so the `auto` default never applies. Check how headless `default` mode treats calls that need approval before relying on it.

Sources:
1. https://github.com/QwenLM/qwen-code (README, 2026-11-15)
2. npm registry, `npm view @qwen-code/qwen-code` (2026-11-15)
3. https://github.com/QwenLM/qwen-code/releases (2026-11-15)
4. https://qwenlm.github.io/qwen-code-docs/en/users/features/headless (2026-11-15)
5. https://qwenlm.github.io/qwen-code-docs/en/users/configuration/settings/ (2026-11-15)
6. https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/ (2026-11-15)

---

## 5. Grok Build (`grok`), xAI's official CLI

Identification: xAI's own coding CLI is **Grok Build**, run as `grok`. The repo is `xai-org/grok-build`, and the README calls it "SpaceXAI's coding agent harness and TUI" [1]. Community "grok-cli" projects exist, but this file covers only the official one.

**Install, version, licence**
- `curl -fsSL https://x.ai/cli/install.sh | bash` or, on Windows, `irm https://x.ai/cli/install.ps1 | iex`. Windows binaries are published [1].
- Licence: Apache-2.0 for first-party code. External contributions are not accepted [1].
- Current version and date: **unknown**. The repo shows no releases, and x.ai/build/changelog returned HTTP 403 [1][2].

**Headless run and JSON**
- `grok -p "<prompt>"` (`--single`), plus `--cwd`, `-s/--session-id`, `-r/--resume`, `-c/--continue` and `--no-alt-screen`. Use `--no-auto-update` in scripts [3].
- `--output-format plain|json|streaming-json`. `json` is one object at the end. `streaming-json` is NDJSON events [3]. **Unknown:** the event schema, and where tokens and cost appear. An ACP mode exists for editors [1][3].
- Headless sessions are stored in `~/.grok/sessions` [3].

**Model**
- `-m/--model`, `GROK_DEFAULT_MODEL`, or `[models] default` (example: `"grok-build"`). `allowed_models`, `hidden_models` and `disabled_models` can limit the choice [4]. The docs promote `grok-4.7` on the xAI API [5]. **Unknown:** the models included with a subscription.

**Sign-in**
- The first launch opens the browser. `grok login` and `/login`/`/logout` exist. Headless and CI runs use `XAI_API_KEY` [5][3][6].
- Status: **unknown** (no status command is documented). `grok inspect` shows config sources, MCP servers, skills and hooks, but not auth [5].

**Tool control (most important)**
- `[permission]` in user or project config, evaluated deny, then ask, then allow. Compact rules look like `Bash(git *)`, `Read(src/**)`, `Edit(**/*.rs)` and `MCPTool(server__*)`. The verbose form is `rules = [{ action, tool, pattern? }]`, where `tool` is one of `any`, `bash`, `edit`, `read`, `grep`, `mcp` or `webfetch` [4].
- `permission_mode` (in `[ui]`) can be `default`, `ask`, `auto` or `always-approve`. Plan mode lets only the plan file be edited [4][6].
- Built-in tools can be switched off: the write tool with `GROK_WRITE_FILE=0` or `[features] write_file = false`, and subagents with `GROK_SUBAGENTS=0`. Web fetch, LSP and memory are off by default. **No switch to turn off bash.** Only deny rules and sandbox profiles limit it [4].
- MCP: `[mcp_servers.<name>]` with `command`/`args`/`env`/`cwd`, or `url`/`headers`/`bearer_token_env_var`. **Watch out:** Grok also reads Claude's and Cursor's MCP configs. Turn that off with `GROK_CLAUDE_MCPS_ENABLED=0` and `GROK_CURSOR_MCPS_ENABLED=0` (or `[compat.claude] mcps = false` and `[compat.cursor] mcps = false`) [4]. A project `.grok/config.toml` can add `[mcp_servers]`, `[plugins]` and `[permission]` [4].
- Per-run config dir: `GROK_HOME` (default `~/.grok`) holds config, auth, sessions, skills, plugins and logs [4].
- **Never pass alone:** `--always-approve` and `permission_mode = "always-approve"` [3][6]. Treat `auto` as unsafe too (it uses a classifier).
- **Unknown:** what a headless run does with a tool call that needs approval when `--always-approve` is not given.

**Logs, sessions, telemetry**
- Logs are under `GROK_HOME`. `GROK_LOG_FILE` and `RUST_LOG` control them. Crash reports go to `$GROK_HOME/crash/` [4].
- Telemetry: **unknown**. No setting is documented, and `/privacy` toggles "privacy and data-retention status" [6].

**Exit codes and errors**
- **Unknown.**

**Can the hive guard it? Probably, but it needs testing.** Set a per-run `GROK_HOME` with deny rules (`{action="deny", tool="bash"}`, `{action="deny", tool="edit"}`), `GROK_WRITE_FILE=0`, compat MCP scanning off, and `--no-auto-update`. Two things are missing: there is no hard switch for bash, and headless behaviour without approval is not documented. Test both before trusting it.

Sources:
1. https://github.com/xai-org/grok-build (2026-11-15)
2. https://x.ai/build/changelog (HTTP 403, 2026-11-15)
3. https://docs.x.ai/build/cli/headless-scripting (2026-11-15)
4. https://docs.x.ai/build/settings/reference (2026-11-15)
5. https://docs.x.ai/build/overview (2026-11-15)
6. https://docs.x.ai/build/modes-and-commands (2026-11-15)

---

## 6. Kimi CLI (Moonshot): now "Kimi Code CLI" (`kimi`)

Identification: the old Python **Kimi CLI** (`MoonshotAI/kimi-cli`, `uv tool install kimi-cli`) is **archived and read-only**. Its README says existing installs "will stop working" and tells users to move to **Kimi Code CLI** [1]. This section covers Kimi Code CLI. The old CLI's `--print` mode turned on `--afk`, which auto-approved tool calls [2]. Do not use the old CLI.

**Install, version, licence**
- `npm install -g @moonshot-ai/kimi-code`, `brew install kimi-code`, `curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash`, or on Windows `irm https://code.kimi.com/kimi-code/install.ps1 | iex` [1][3].
- Version 2.6.2, released 2026-11-14 according to the changelog (npm publish time is 2026-11-13T17:28Z) [4][5]. Licence: MIT [5][6].

**Headless run and JSON**
- `kimi -p "<prompt>"`. `--output-format text|stream-json` works only with `-p`. `stream-json` is one JSON object per stdout line, without thinking content. Thinking, tool progress and notices go to stderr [7]. **Unknown:** the event schema and where usage appears. Stdin input is not documented.

**Model**
- `-m/--model <alias>` or `default_model` in config [7]. `kimi provider list|catalog` manages providers [7]. **Unknown:** the models included with a Kimi Code subscription.

**Sign-in**
- `kimi login` (device-code OAuth) exits 0 on success and 1 on cancel or failure. `/login` offers Kimi Code OAuth or a Moonshot Open Platform API key [7][6].
- Status: **unknown** (no status command is documented). `kimi doctor` only checks config files [7].

**Tool control (most important)**
- **Watch out:** "non-interactive mode uses `auto` permission by default", and `-p` cannot be combined with `--yolo`, `--auto` or `--plan` [7]. `--auto` is "Never Ask" mode. Since 0.41.0, auto mode no longer blocks dangerous or unanalysable commands [4]. So every `-p` run auto-approves everything except static deny rules.
- Tools can be turned off: in config, `[tools] enabled` is an allowlist and `disabled` is a denylist applied after it. It applies to all agents, and MCP tools can be matched with globs like `mcp__github__*` [8].
- Rules: `[[permission.rules]]` with `decision` (allow, deny or ask) and a `pattern` like `Bash(rm -rf*)`. Deny beats ask, and ask beats allow. `dangerous_command_guard = false` would turn off the built-in guards [8].
- MCP: `~/.kimi-code/mcp.json` or the project's `.kimi-code/mcp.json` (only for trusted folders) [8]. **Unknown:** a per-run MCP flag. The old CLI had `--mcp-config-file`, but the new reference does not list it [2][7].
- Per-run config dir: `KIMI_CODE_HOME` (default `~/.kimi-code`) [7][8].
- **Never pass alone:** `--yolo`/`-y`/`--yes`/`--auto-approve`, `--auto`, `default_permission_mode = "yolo"` or `"auto"`, and `dangerous_command_guard = false` [7][8]. Plain `-p` is itself auto-approve, so never run `-p` without a `[tools]` allowlist.

**Logs, sessions, telemetry**
- Data lives under `KIMI_CODE_HOME`. A separate "Data Locations" page exists but was not read [8].
- Telemetry is **on by default**. Turn it off with `telemetry = false` in `config.toml` [8]. The changelog also names `KIMI_DISABLE_TELEMETRY`, which `kimi -p` has respected since 0.41.0 [4].

**Exit codes and errors**
- Conflicting flags are rejected at startup. `kimi login` and `kimi doctor` use 0 and 1. Since 0.23.2, `kimi -p` exits non-zero when a turn fails [7][4]. Other codes are unknown.

**Can the hive guard it? Yes, but only through config.** Each run needs a per-run `KIMI_CODE_HOME` whose `config.toml` sets `[tools] enabled` to a short allowlist (no shell or write for read-only workers), deny rules, `telemetry = false`, and the hive's `mcp.json`. Without that config, `-p` auto-approves everything.

Sources:
1. https://github.com/MoonshotAI/kimi-cli (archived README, 2026-11-15)
2. https://moonshotai.github.io/kimi-cli/en/reference/kimi-command.html (old CLI, 2026-11-15)
3. https://moonshotai.github.io/kimi-code/en/ (2026-11-15)
4. https://moonshotai.github.io/kimi-code/en/release-notes/changelog (2026-11-15)
5. npm registry, `npm view @moonshot-ai/kimi-code` (2026-11-15)
6. https://github.com/MoonshotAI/kimi-code (2026-11-15)
7. https://moonshotai.github.io/kimi-code/en/reference/kimi-command (2026-11-15)
8. https://moonshotai.github.io/kimi-code/en/configuration/config-files (2026-11-15)

---

## 7. Crush (Charm) (`crush`)

**Install, version, licence**
- `npm install -g @charmland/crush`, `winget install charmbracelet.crush`, `brew install charmbracelet/tap/crush`, or `go install github.com/charmbracelet/crush@latest` [1].
- Version v0.101.0, released 2026-11-12 [2][3]. Licence: **FSL-1.1-MIT**, a source-available licence that is not open source on day one (it becomes MIT later) [1][2].

**Headless run and JSON**
- `crush run "<prompt>"`. Stdin is added to the prompt. Flags are `-q/--quiet`, `-v/--verbose`, `-m/--model`, `--small-model`, `--reasoning-effort`, `-s/--session` and `-C/--continue` [4].
- **No JSON output.** `crush run` defines no output-format flag. The reply text goes to stdout [4]. No usage or token data is given.

**Model**
- `-m` takes `model` or `provider/model`. `crush models` lists models as `<provider>/<id>` [4][5]. Charm's own provider is "Hyper", and the model list comes from Catwalk [6].

**Sign-in**
- Mostly API keys in env vars (`HYPER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `MOONSHOT_API_KEY`, …) [7]. Release notes mention OAuth sign-in (for example Grok OAuth, added in v0.98.0) [3]. **Unknown:** the login command name and a status command.

**Tool control (most important)**
- **Watch out:** in the source, the non-interactive run calls `app.Permissions.AutoApproveSession(sess.ID)` with the comment "Automatically approve all permission requests for this non-interactive" run [8]. So `crush run` approves every tool call it can see.
- The only real guard is hiding tools. `permissions deny <tool> ...` in a `crushrc` file "hides tools from the agent entirely". `permissions allow ...` skips prompts [9]. Tool names we saw include `bash`, `edit`, `view`, `ls`, `grep` and `sourcegraph` [9]. **Unknown:** the full list (`write`, `multiedit`, `fetch`, …).
- v0.100.0 added `permissions safe|block|unblock` and a configurable dangerous-command list. Yolo mode still blocks the dangerous commands [3].
- Config: `crushrc` (the JSON format is deprecated). Priority is `./.crushrc`, then `./crushrc`, then `~/.config/crush/crushrc` [1]. **Watch out:** a repo's own `.crushrc` comes first. **Unknown:** whether it can undo the hive's denies.
- `CRUSH_GLOBAL_CONFIG` and `CRUSH_GLOBAL_DATA` move the global config and data [7]. The README also names `CRUSH_DATA_DIR` for the per-project `.crush` dir [1].
- MCP: declared in crushrc (`mcp add <name> --command ... --args ...`, `--type http|sse --url ...`). MCP tools can be hidden with `--disabled-tools` [1][6].
- **Never pass alone:** `--yolo` ("Skip all permission prompts. Be very, very careful.") [5]. Plain `crush run` is already auto-approve.

**Logs, sessions, telemetry**
- Logs are in `./.crush/logs/crush.log`, inside the project folder (`crush logs --tail/--follow`) [1].
- Metrics are on by default and hold usage metadata only. Turn them off with `CRUSH_DISABLE_METRICS=1` or `DO_NOT_TRACK=1` [6][7].

**Exit codes and errors**
- Errors such as "no prompt provided", "no providers configured…", "agent run failed: …" and a 30 s readiness timeout are returned as errors [4]. **Unknown:** the exit-code numbers.

**Can the hive guard it? Only weakly.** `crush run` auto-approves, has no JSON output, and lets the repo's own `.crushrc` take priority. The only guard is a deny list (`permissions deny bash edit …`) in a hive-owned global crushrc via `CRUSH_GLOBAL_CONFIG`. Use it only inside a container, or skip it.

Sources:
1. https://github.com/charmbracelet/crush and https://raw.githubusercontent.com/charmbracelet/crush/main/README.md (2026-11-15)
2. npm registry, `npm view @charmland/crush` (2026-11-15)
3. https://github.com/charmbracelet/crush/releases (2026-11-15)
4. https://raw.githubusercontent.com/charmbracelet/crush/main/internal/cmd/run.go (2026-11-15)
5. https://next-docs.charm.land/crush/reference/cli.html (Charm docs, 2026-11-15)
6. https://raw.githubusercontent.com/charmbracelet/crush/main/README.md (metrics, Hyper, Catwalk sections, 2026-11-15)
7. https://next-docs.charm.land/crush/reference/environment-variables.html (2026-11-15)
8. https://raw.githubusercontent.com/charmbracelet/crush/main/internal/app/app.go (`RunNonInteractive`, 2026-11-15)
9. https://next-docs.charm.land/crush/configuration/permissions.html (2026-11-15)

---

## 8. Pi (`pi`), the coding agent from the pi-mono / Earendil project

Identification: "Pi" is the minimal coding-agent harness started by Mario Zechner (`badlogic/pi-mono`). The repo is now `earendil-works/pi`, and the npm package is **`@earendil-works/pi-coding-agent`**, binary `pi` [1][2]. The old package `@mariozechner/pi-coding-agent` stopped at 0.73.1 (last changed 2026-05-07) [2].

**Install, version, licence**
- `npm install -g --ignore-scripts @earendil-works/pi-coding-agent` (needs Node 22.19+), `curl -fsSL https://pi.dev/install.sh | sh`, a PowerShell installer, or Nix (`nix run github:earendil-works/pi/stable`) [1][3].
- Version 1.5.2, published to npm on 2026-11-10 [2]. Licence: MIT [1][2].

**Headless run and JSON**
- `pi -p "<prompt>"` prints the final text. `--mode json` prints JSONL events, and `--mode rpc` reads JSONL commands on stdin. Piped stdin is added to the first prompt, and `@file` attaches a file [4].
- JSON: a session header, then lifecycle, message, tool, compaction and retry events. `message_update` carries `usage` with `input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens` and `cost`. `agent_settled` means all work is done, so don't stop at `agent_end`. Diagnostics go to stderr [5].

**Model**
- `--model` (exact or fuzzy, `provider/id`, optional `:<thinking>`), `--provider`, `--thinking off…max`, and `--api-key` (not saved) [4]. Pi works with about 40 providers [6].

**Sign-in**
- `/login [provider]` (browser or device OAuth, or an API key), `/logout`. Credentials are stored in `auth.json` in the agent dir [6].
- Status: `pi auth check` exits 0 if ready, 1 if not ready, 2 if invalid [4].

**Tool control (most important)**
- **Watch out:** "Pi does not include a built-in permission system for restricting filesystem, process, network, or credential access." The README says to use a container or sandbox [7]. By default the tools `read`, `bash`, `edit` and `write` run without asking.
- Hard switches: `-t/--tools <list>` replaces the default tools with an allowlist (built-ins are `read`, `bash`, `powershell` on Windows, `edit`, `write`, `grep`, `find` and `ls`). `-nt/--no-tools` turns off every tool, including extension and MCP tools [4]. `-ne/--no-extensions` and `-ns/--no-skills` stop extensions and skills from loading [4].
- MCP: built in as the `builtin:mcp` extension and **on by default**. Configs are `~/.pi/agent/mcp.json` and project `.pi/mcp.json` (only after project trust), using `mcpServers` with stdio or HTTP entries. `--no-mcp` turns it off for one run [8].
- Per-run config dir: `PI_CODING_AGENT_DIR` (default `~/.pi/agent`). `PI_CODING_AGENT_SESSION_DIR` or `--session-dir` sets session storage, and `--no-session` keeps the session in memory only [9][4].
- **Never pass alone:** pi has no "approve everything" flag, because running pi with no `--tools` already gives full shell and write access. Every hive preset must pass `--tools`.

**Logs, sessions, telemetry**
- Sessions are JSONL files under the agent dir unless moved [9][4].
- Telemetry: `PI_TELEMETRY=0` turns off install/update telemetry and provider attribution headers. `PI_OFFLINE=1` stops automatic network activity, and `PI_SKIP_VERSION_CHECK` stops the version check [9].

**Exit codes and errors**
- Only `pi auth check`, `pi auth logout` and `pi mcp list` have documented codes [4][8]. Errors appear as `auto_retry_end` (`success: false`, `finalError`) and nested `error` events [5]. **Unknown:** the exit codes for `-p`.

**Can the hive guard it? Yes, by allowlist.** Always pass `--tools` with exactly the tools the worker needs (for example `read,grep,find,ls` for a reviewer), plus `--no-extensions`, `--no-skills`, a per-run `PI_CODING_AGENT_DIR`, `--no-session` or `--session-dir`, and `PI_TELEMETRY=0`. Pi cannot limit what `bash` or `write` may touch, so any preset that includes them needs the container.

Sources:
1. https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent (2026-11-15)
2. npm registry, `npm view @earendil-works/pi-coding-agent` and `@mariozechner/pi-coding-agent` (2026-11-15)
3. https://raw.githubusercontent.com/badlogic/pi-mono/main/README.md (2026-11-15)
4. https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/docs/cli.md (2026-11-15)
5. https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/docs/json.md (2026-11-15)
6. https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/providers.md (2026-11-15)
7. https://raw.githubusercontent.com/badlogic/pi-mono/main/README.md ("Pi does not include a built-in permission system…", 2026-11-15)
8. https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/mcp.md (2026-11-15)
9. https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/docs/environment-variables.md (2026-11-15)

---

## 9. Google Antigravity CLI (`agy`)

Identification: yes, a CLI exists. Google announced **Antigravity CLI** on 2026-05-19 as the replacement for Gemini CLI. It is written in Go and shares the harness of the Antigravity 2.0 desktop app [1]. From 2026-06-18, Gemini CLI stopped serving Google AI Pro and Ultra users and free Code Assist users. It remains available with paid Gemini API or Enterprise keys [1]. This matches our "Gemini on hold" note.

**Install, version, licence**
- `curl -fsSL https://antigravity.google/cli/install.sh | bash`, or on Windows `irm https://antigravity.google/cli/install.ps1 | iex` (a CMD variant also exists) [2].
- Current version: **unknown**. The codelab used 1.1.27, and the docs mention features needing v1.3.5+ (macOS/Linux) and v1.4.4+ (Windows) [2][3]. Licence: **unknown**. No licence is stated, and business use falls under the Google Cloud terms [4].

**Headless run and JSON**
- `agy -p "<prompt>"` (`--print`/`--prompt`). `--input-format stream-json` feeds prompts on stdin [5].
- `--output-format text|json|stream-json`. `json` is one envelope at the end with `status`, `error` and `usage` (`input_tokens`, `output_tokens`, `thinking_tokens`, `cache_read_tokens`, `total_tokens`). `stream-json` sends the events `init`, `step_update` and `result` [5]. `--json-schema` enforces structured output, and `--print-timeout` is available [6]. Cost is not given.

**Model**
- `--model <slug>`, listed by `agy models`. `--effort` sets reasoning effort [5][6]. `/usage` shows quota [6]. **Unknown:** the model list per plan. Personal plans are Free, Pro and Ultra [4].

**Sign-in**
- On first run the browser opens for Google OAuth (or a paste-code flow over SSH). Other options are a Gemini API key (`"modelProvider": "gemini"` plus `GEMINI_API_KEY`) or Cloud ADC (`AGY_ADC_AUTH=true`) [4].
- Headless needs cached credentials from one interactive run first. Without them it exits with "authentication required" instead of hanging [5].
- Status: **unknown** (no status command is documented) [4].

**Tool control (most important)**
- Rules live in `~/.gemini/antigravity-cli/settings.json` under `permissions.allow` / `ask` / `deny`, as `action(target)`. Actions are `read_file`, `write_file`, `read_url`, `execute_url`, `command`, `unsandboxed` (business accounts only) and `mcp(server/tool)`. Deny beats ask, and ask beats allow. `command(*)` matches every command [7]. So `"deny": ["write_file(*)", "command(*)"]` should block writes and shell. This is our reading of the syntax and is not tested.
- Modes: `default` (review before writes and commands), `accept-edits`, `auto` (needs the sandbox and a personal account) and `plan` [3][6]. `toolPermission` values include `strict`, `always-proceed`, `proceed-in-sandbox` and `request-review` [7][8].
- Headless: tool calls that need approval are **soft-denied**. "The run continues, exits `0`, and prints a notice to `stderr`" [5]. So exit 0 does not mean the task was done.
- Sandbox: `--sandbox` per run, or `enableTerminalSandbox`. On Windows it uses AppContainer and needs Windows 11 24H2 with the August 2026 update or later. Without that, the flag has no effect [8].
- MCP: global `~/.gemini/config/mcp_config.json` and workspace `.agents/mcp_config.json`, using `mcpServers` with `serverUrl` or `env` [9]. **Unknown:** a per-run MCP flag.
- Per-run config dir: **none documented**. The settings path is fixed [7][6].
- **Never pass alone:** `--dangerously-skip-permissions` ("approves all tool calls, including file writes and command execution") and `toolPermission: "always-proceed"` [5][7]. Be careful with `--mode auto` and `--mode accept-edits` [3].

**Logs, sessions, telemetry**
- `--log-file` overrides the log path, and the default is not documented. Prompt history is kept on disk (`historySize`, default 2000) [6].
- Telemetry: "Enable Telemetry" in `/config` has no `settings.json` key. The choice is saved with the account [6].

**Exit codes and errors**
- Exit 0 on success, including soft-denied tool calls. Non-zero if no response, with the reason on stderr. Bad stdin events exit 2 and invalid JSON input exits 1. In JSON modes, errors show in `status` and `error` [5].

**Can the hive guard it? Partly.** Headless soft-denies by default, and the deny rules are expressive. But there is no per-run config dir, so the hive would have to edit the user's own global `settings.json`. MCP config is also global. The Windows sandbox needs a very recent Windows 11 build. Exit 0 can hide denied work, so the hive must read stderr or the `status` field.

Sources:
1. https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/ (2026-11-15)
2. https://codelabs.developers.google.com/antigravity-cli-hands-on (2026-11-15)
3. https://antigravity.google/docs/cli/modes.md (2026-11-15)
4. https://antigravity.google/docs/install.md (2026-11-15)
5. https://antigravity.google/docs/cli/headless.md (2026-11-15)
6. https://antigravity.google/docs/cli/reference.md (2026-11-15)
7. https://antigravity.google/docs/permissions.md (2026-11-15)
8. https://antigravity.google/docs/sandbox.md (2026-11-15)
9. https://antigravity.google/docs/cli/gcli-migration.md (2026-11-15)

---

## Summary table

| CLI | Install | Headless | JSON output | MCP from config | Can turn off its own tools | Verdict |
|---|---|---|---|---|---|---|
| Copilot CLI `copilot` 1.0.112 | `npm i -g @github/copilot` / `winget install GitHub.Copilot` | `-p`; unapproved tools auto-denied | JSONL (`--output-format json`); event schema unknown | `~/.copilot/mcp-config.json`, `--additional-mcp-config`, `COPILOT_HOME` | Yes: `--available-tools`, `--excluded-tools`, `--deny-tool` | **Yes** |
| Codex `codex` 0.169.0 | `npm i -g @openai/codex` | `codex exec`, stdin `-` | JSONL `--json`, usage on `turn.completed` | `[mcp_servers]` in `config.toml`, `CODEX_HOME` | Yes: OS sandbox `read-only`; `features.shell_tool=false` | **Yes (strongest)** |
| Cursor `agent` (version unknown) | `curl https://cursor.com/install` / PowerShell | `-p`; **writes files by default** | `json` / `stream-json`; no tokens | `.cursor/mcp.json` only (no per-run file) | Partly: `--mode ask`, deny rules, `CURSOR_CONFIG_DIR` | **Partly** |
| Qwen Code `qwen` 0.27.4 | `npm i -g @qwen-code/qwen-code` | `-p`, stdin | `json` / `stream-json` with usage | `mcpServers`, `QWEN_HOME` | Yes: `permissions.deny` (Bash, Edit, Write) | **Yes** (always pass `--approval-mode`) |
| Grok Build `grok` (version unknown) | `curl https://x.ai/cli/install.sh` / PowerShell | `-p` | `json` / `streaming-json`; schema unknown | `[mcp_servers]`, `GROK_HOME`; also reads Claude/Cursor MCP configs | Partly: deny rules, `GROK_WRITE_FILE=0`; no bash switch | **Probably, test first** |
| Kimi Code `kimi` 2.6.2 (old kimi-cli archived) | `npm i -g @moonshot-ai/kimi-code` | `-p` = **auto-approve** | `stream-json`; schema unknown | `mcp.json` in `KIMI_CODE_HOME` | Yes: `[tools] enabled/disabled`, deny rules | **Yes, only with per-run config** |
| Crush `crush` 0.101.0 | `npm i -g @charmland/crush` / winget | `crush run` = **auto-approve** | **None** | crushrc `mcp add`; repo `.crushrc` wins | Only by hiding tools (`permissions deny`) | **Weak; container only** |
| Pi `pi` 1.5.2 | `npm i -g --ignore-scripts @earendil-works/pi-coding-agent` | `-p`, `--mode json/rpc` | JSONL with usage and cost | `mcp.json`, `PI_CODING_AGENT_DIR`, `--no-mcp` | Yes: `--tools` allowlist / `--no-tools`; **no permission system** | **Yes, by allowlist** |
| Antigravity `agy` (version unknown) | `curl https://antigravity.google/cli/install.sh` / PowerShell | `-p`; unapproved tools soft-denied (exit 0) | `json` / `stream-json` with usage | Fixed global `mcp_config.json` | Yes by deny rules, but only in the global settings file | **Partly** |

Flags the hive must never pass alone: Copilot `--allow-all-tools`, `--allow-all`, `--yolo`, `--allow-all-paths`, `--allow-all-urls`, `COPILOT_ALLOW_ALL`. Codex `--dangerously-bypass-approvals-and-sandbox` / `--yolo`, `--sandbox danger-full-access`. Cursor `--force` / `--yolo`, `--approve-mcps`, `--sandbox disabled`, `approvalMode: unrestricted`. Qwen `--yolo`, `--approval-mode yolo` (and `auto`). Grok `--always-approve`. Kimi `--yolo`, `--auto` (and bare `-p` without a tools allowlist). Crush `--yolo` (and bare `crush run`). Pi has no such flag, but bare `pi` is already unrestricted. Antigravity `--dangerously-skip-permissions`, `toolPermission: always-proceed`.
