# 04 — Connections

**Status:** Finalized (2026-11-12)
**Created:** 2026-11-12
**Last updated:** 2026-11-12

---

## Purpose

Everything the AIOS can reach, and how it reaches it safely: the user's **AI subscriptions**, **model API providers** (OpenRouter, FreeLLMAPI, local models), and **outside tools and services** (GitHub, Notion, email…). This is the "Connections" C of the 4Cs. Without it the Hive cannot run.

## What the user asked for

- Users sign in to their **own AI tool subscriptions** (from 01-D5).
- Users can add **custom providers** like FreeLLMAPI or OpenRouter (from 01-D5).
- Use **Munder Difflin** as the model for how connections work.

## Three kinds of connection

| Kind | Examples | How agents use it |
|---|---|---|
| **1. AI engines** (subscription CLIs) | Claude Code, Codex, Gemini CLI, Copilot, Cursor, Qwen, OpenCode, Grok, Kimi, Pi, Crush | Each insect *is* one of these, running as a real terminal process on the user's own subscription |
| **2. Model API providers** (bring your own key) | OpenRouter, FreeLLMAPI, Anthropic/OpenAI API keys, any OpenAI-compatible endpoint, local Ollama / LM Studio / vLLM | Plugged into engines that accept a base URL (OpenCode, Crush, Pi…) or into API-based agents |
| **3. Outside tools & services** | GitHub, web search/fetch, filesystem, git, Notion, Linear, Jira, Slack, Stripe, Gmail, Calendar | Through MCP servers, CLIs (`gh`, `git`), or REST APIs via the secret broker |

## Reference: how Munder Difflin connects things (read from its source, MIT)

**AI engines**
- 12 engine presets: Claude Code, Codex, Grok, Kimi, Gemini CLI, Antigravity, Qwen, OpenCode, Crush, Pi, Copilot, Cursor, plus "custom command". Each preset knows its binary, model flag, auto-approve flag, resume flag and install command.
- **Sign-in is done by the CLI itself.** The app runs the real CLI in a terminal; the user logs in there with the vendor's own flow. The app never sees the password or OAuth token.
- **Availability check before use:** each engine is classified *installed / installable / manual-only / unknown* so the setup wizard warns before a user picks an engine that can't start.
- **Install ladder:** npm available → `npm install -g`; no npm but a Node installer found → install Node, then npm; else the vendor's native installer; else manual instructions only. Never runs a command that is sure to fail.
- **"Bridges" for live status:** Claude Code gets status via its hook settings; other CLIs get an adapter (hook shims for Codex/Gemini/Grok, a plugin for OpenCode, or an API proxy). This is how the app knows each agent is working / idle / waiting.
- **Lesson learned — silent model fallback:** OpenCode quietly switched to a different free model when the chosen key was missing, while the app kept showing the chosen model. Fix: never assume; report the model actually running.

**Model API providers**
- Per-engine base URL for local/self-hosted models (Ollama, LM Studio, vLLM) and a default model per engine.
- API keys are **never stored in config**; they go into the encrypted secret store and are read only by the main process when an agent starts.

**Secrets (best idea to adopt)**
- **Encrypted at rest** with the operating system's own encryption (Electron `safeStorage`: Windows DPAPI, macOS Keychain, Linux secret service), in a file separate from settings.
- **Fail closed:** if OS encryption is unavailable, the secret is not saved at all (no plaintext fallback).
- **Never** returned to the UI, logged, put in an agent's environment or transcript, or echoed in errors. Records only carry a `secretRef` handle.

**Loopback secret broker (best idea to adopt)**
- A local-only (127.0.0.1) proxy. A worker calls `http://127.0.0.1:<port>/i/<integration-id>/<path>` with a **per-worker capability token** (not a secret).
- The broker checks the token, checks the integration is enabled, decrypts the real key, injects it as the auth header, forwards to the registered API, and streams the answer back. **The agent uses the service without ever seeing the key.**
- Not an open proxy: workers pick an integration by id, never a host; paths stay inside the registered base URL; dangerous headers are stripped.

**Integration records** (metadata only): `id`, `label`, `kind`, `baseUrl`, `authType` (none / bearer / header / github), `authHeader`, `secretRef`, `enabled` (consent gate). Ready templates: Linear, Jira, Notion, Stripe, Confluence, Sentry, HubSpot. **OAuth tools (Gmail, Google Calendar, Salesforce) are not done yet**: they need an OAuth broker that holds and refreshes tokens.

**MCP servers by consent tier**
- `safe-readonly` (no secret, no writes outside the workspace) → ON by default: sequential-thinking, time, fetch, context7, filesystem and git (both scoped to the agent's folder, never the whole disk).
- `write` (changes things outside the workspace) → OFF until the user consents.
- `secret` (needs a key) → OFF until the user consents: GitHub token, database, email/calendar, search with key.

**Different from us:** Munder Difflin's anonymous telemetry is ON by default (opt-out). Ours sends nothing (01-D8).

## Design (agreed 2026-11-12 via D2–D7)

1. **Connections registry in the Brain** (like AIS-OS `connections.md`, but a table): every engine, provider and service with kind, mechanism (CLI / API key / OpenAI-compatible URL / MCP / REST), auth status, consent tier, which castes may use it, health, and last checked.
2. **Engine onboarding:** detect → offer install (with consent) → user signs in with the engine's own login → health check (can it start, which models, which effort levels) → available to the router (02-D9).
3. **Truth about models:** the AIOS records the model and effort that actually ran (from the engine's own output), not the one it asked for; mismatches alert the Treasurer.
4. **Subscription limits:** track each subscription's usage and limit windows (e.g. 5-hour and weekly caps) so the Treasurer routes around exhausted subscriptions and lowers the insect limit before hitting them (02-D7).
5. **Vault:** OS-encrypted secret store, fail closed, handles only. Ties to Brain secrets guard (01-E6).
6. **Secret broker:** agents reach REST services only through the local broker with per-insect, per-task capability tokens that expire when the card ends. Insects get only the integrations their card needs (least privilege).
7. **MCP consent tiers:** safe-readonly on, write and secret off until the user consents; filesystem/git always scoped to the task workspace.
8. **OAuth broker (later phase):** for Gmail, Calendar, Salesforce and similar; the broker holds and refreshes tokens.
9. **Generic OpenAI-compatible provider:** one form (name, base URL, key, model list) covers OpenRouter, FreeLLMAPI, local servers and others; presets pre-fill the common ones.

## Inputs / Outputs

- **Inputs:** user sign-ins, pasted keys, consent choices; engine/provider health and usage signals.
- **Outputs:** a registry of what's reachable and healthy; capability tokens per task; usage data for the Treasurer.

## Dependencies on other functions

- **01 Memory:** registry lives in the Brain; secrets guard (E6); nothing uploaded (D8); tool-agnostic doors (D5).
- **02 Hive:** router picks among connected engines/models (D9 P1); limits and approvals (D7); Watchdog/Treasurer use health and usage.
- **03 Capabilities:** agent `tools` and `permissions` decide which connections a caste may use; `tools/` entries in the library (agent-browser, playwright-mcp).

## Open questions

- [x] Q1 — Launch engines → D2.
- [x] Q2 — Launch API providers → D3.
- [x] Q3 — Vault + secret broker → D4.
- [x] Q4 — Outside services, in phases → D5.
- [x] Q5 — Installing missing CLIs → D6.
- [x] Q6 — Subscription usage tracking → D7.

*All questions closed as of 2026-11-12 (user accepted Claude's suggestions for all).*

## Decisions made

- **D1 (2026-11-12) — Connections is function 04**, modelled on Munder Difflin's approach.
- **D2 (2026-11-12) — Launch engines:** Claude Code, Codex, Gemini CLI, and OpenCode (as the doorway for OpenRouter, FreeLLMAPI and local models). Next: Copilot, Cursor, then the rest (Qwen, Grok, Kimi, Pi, Crush, Antigravity, custom command). Sign-in always happens in the engine's own login; the AIOS never sees passwords or login tokens. Each engine gets a status bridge, and the AIOS records the model and effort that actually ran (draft item 3).
- **D3 (2026-11-12) — Launch API providers:** one generic "OpenAI-compatible provider" form (name, base URL, key, model list) with presets for OpenRouter, FreeLLMAPI, Ollama and LM Studio, plus direct Anthropic and OpenAI API keys. The UI notes that FreeLLMAPI is meant for personal use and that free-tier terms can change.
- **D4 (2026-11-12) — Vault + secret broker adopted** (draft items 5–6). OS-encrypted vault, fail closed, handles only. Agents reach keyed services only through the local broker. **Improvement over Munder Difflin:** each insect's capability token is scoped to its current task card and to only the integrations that card needs, and expires when the card ends.
- **D5 (2026-11-12) — Outside services in three phases.**
  - *Phase 1:* GitHub, web search and fetch, filesystem and git (scoped to the task workspace).
  - *Phase 2:* Notion, Linear, Jira, Slack (and the other ready REST templates as needed).
  - *Phase 3:* Gmail, Google Calendar and other OAuth services, after the OAuth broker (draft item 8) is built.
  - MCP consent tiers (draft item 7) apply throughout: safe-readonly on by default; write and secret off until the user consents.
- **D6 (2026-11-12) — One-click install with consent.** Missing engine CLIs can be installed in one click, but the AIOS first shows the exact command and asks; it follows an install ladder (package manager → runtime + package manager → vendor installer → manual instructions) and never runs a command that is sure to fail.
- **D7 (2026-11-12) — Automatic subscription usage tracking.** The AIOS tracks each subscription's usage and limit windows (e.g. 5-hour, weekly) so the Treasurer routes around exhausted subscriptions and lowers the insect limit before limits hit (02-D7, 02-D9).

## Change log

- 2026-11-12 — Created from Munder Difflin source review; draft design and questions.
- 2026-11-12 — User accepted all suggestions → D2–D7. Draft design items 1–9 now form the agreed baseline.
- 2026-11-12 — **Finalized by user.** Further changes go through a new change-log entry.
