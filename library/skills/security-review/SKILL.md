---
name: security-review
description: 'OWASP-style security review of code and configuration: secrets, injection, XSS, access control, authentication, sensitive data, SSRF, unsafe deserialization, dependencies and infrastructure. Use when a change touches user input, auth, API endpoints, file uploads, payments, webhooks, crypto, secrets or sensitive data, when dependencies change, and before any release.'
metadata:
  kind: skill
  castes: [reviewer, coder, inspector]
  tags: [security, review, owasp, quality]
  version: 1
  status: vetted
  sources:
    - repo: affaan-m/ecc
      path: skills/security-review/SKILL.md
      license: MIT
    - repo: affaan-m/ecc
      path: skills/security-review/cloud-infrastructure-security.md
      license: MIT
    - repo: affaan-m/ecc
      path: agents/security-reviewer.md
      license: MIT
---

# Security Review

Find vulnerabilities before they ship. One hole can expose every user, so look carefully, but report only what you can show: a guessed vulnerability wastes a fix and erodes trust like any other false finding.

This skill builds on code-review: same confidence gate, same one-line output, same verdicts. It adds the security checklist and rules for handling what you find.

## When to use

**Always** for changes that touch: authentication or authorization, user input or file uploads, new or changed API endpoints, database queries, payments or value transfers, webhooks, external API integrations, cryptography, secrets, personal or sensitive data, dependency updates, infrastructure or CI configuration.

**Immediately** for: a reported vulnerability, a dependency advisory affecting the project, an incident, or a pre-release check.

## Principles

1. **Never trust input.** Validate at every boundary with allowlists, not denylists.
2. **Least privilege.** Every user, service, token and role gets the minimum it needs.
3. **Defense in depth.** No single check is the only thing standing between an attacker and the data.
4. **Fail securely.** Errors deny access and reveal nothing internal.
5. **Keep dependencies current** and locked.

## Workflow

1. **Scope.** Read the diff and card. List the trust boundaries the change touches: where untrusted data enters, where it is stored, where it leaves, who is allowed to do what.
2. **Scan.** Run the project's available tools: dependency audit, security linter, secret scanner (examples per language in [references/owasp-checklist.md](references/owasp-checklist.md#scanning-tools)). Search the changed files for secret-shaped strings. Do not install new tools or send code to external services without approval.
3. **Review high-risk areas first:** auth, endpoints, queries, uploads, payments, webhooks, anything that runs commands or fetches URLs.
4. **Walk the checklist** below. For each relevant item, trace real data flow from the entry point to the sink.
5. **Confirm each finding** through the code-review confidence gate. A security finding at critical or high needs: the line, the attack (input, path, outcome), and why existing guards (framework escaping, ORM, middleware, types) do not stop it.
6. **Report** and set the verdict.

## Checklist (OWASP-style)

| # | Area | Check |
|---|---|---|
| 1 | Injection | Queries parameterized; no string-built SQL/NoSQL; no user input in shell commands (use argument lists, allowlists); no `eval` / dynamic code on input; template injection. |
| 2 | Broken authentication | Passwords hashed with a slow algorithm (bcrypt, scrypt, argon2); tokens signature- and expiry-checked; sessions in httpOnly, Secure, SameSite cookies, not browser storage; brute-force throttling on login and reset. |
| 3 | Sensitive data exposure | Secrets from environment or a secret manager, never in source or history; HTTPS enforced; sensitive data encrypted at rest; no secrets or personal data in logs; generic error messages to clients, details only in server logs. |
| 4 | XML external entities | XML parsers with external entities and DTDs disabled. |
| 5 | Broken access control | Authorization checked on every route and operation, server-side, per object (no reading another user's record by changing an id); row-level ownership enforced in queries or database policies; CORS limited to known origins. |
| 6 | Security misconfiguration | Debug mode off in production; default credentials changed; security headers set (CSP without `unsafe-inline`/`unsafe-eval` by default, frame-ancestors, nosniff, referrer policy); least-privilege service accounts. |
| 7 | Cross-site scripting | Framework auto-escaping not bypassed; user HTML sanitized with an allowlist sanitizer at the same call site; user URLs scheme-checked (no `javascript:`); CSP set. |
| 8 | Insecure deserialization | No unsafe deserializers on untrusted data (native object deserialization, unsafe YAML loaders); schema-validate parsed JSON. |
| 9 | Known vulnerable components | Dependency audit clean at high and above; lockfiles committed; reproducible installs in CI. |
| 10 | Logging and monitoring | Security events logged (failed logins, permission denials, admin actions) without sensitive data; alerts for anomalies. |
| + | CSRF | State-changing requests authenticated by cookies have CSRF tokens or SameSite=Strict/Lax as appropriate. |
| + | SSRF | Server-side fetches of user-supplied URLs restricted to an allowlist of hosts; internal addresses blocked. |
| + | Rate limiting | Public and expensive endpoints throttled per IP and per user. |
| + | File uploads | Size, type and extension allowlisted; stored outside the web root under generated names; path traversal impossible. |
| + | Value transfers | Recipient and amount validated server-side; balance check and debit in one transaction with a row lock; idempotency on retries; no blind signing. |

Detailed checks, code examples and security test patterns: [references/owasp-checklist.md](references/owasp-checklist.md). Cloud, CI/CD, network and backup checks: [references/cloud-infrastructure.md](references/cloud-infrastructure.md).

## Patterns to flag on sight

| Pattern | Severity | Fix |
|---|---|---|
| Hardcoded secret, key or password | critical | Load from environment or secret manager; rotate it |
| User input in a shell command | critical | Argument-list API, allowlist values |
| String-built SQL with user input | critical | Bound parameters / ORM |
| Plaintext password storage or comparison | critical | Slow hash and its compare function |
| Route or operation with no auth check | critical | Add authentication and authorization |
| Balance or stock check without a lock | critical | Check and update in one transaction with a row lock |
| User HTML assigned as raw markup | high | Text content, or allowlist sanitizer |
| Server fetch of a user-provided URL | high | Host allowlist, block internal ranges |
| No rate limit on login or expensive endpoint | high | Per-IP and per-user throttling |
| Session token in browser storage | high | httpOnly Secure cookie |
| Secrets or passwords written to logs | medium | Redact before logging |

## Common false positives (check context first)

- Placeholder values in `.env.example` or docs.
- Clearly marked test credentials in test files.
- Keys that are public by design (publishable keys, public client ids).
- MD5 or SHA-1 used for checksums or cache keys, not passwords or signatures.
- Non-cryptographic randomness used for jitter, sampling or animation.

## Handling findings

- **Never copy a secret's value** into a finding, card result, log or the Brain. Cite file and line and the secret's type only.
- A real exposed secret is critical: mark the card blocked and escalate to the Queen at once. Rotation, history rewriting, and notifying anyone outside the hive need user approval.
- Include the fix: a secure code example at the same call site.
- After a fix, verify it: re-run the scan and add a test that proves the attack now fails (e.g. unauthenticated request returns 401, other user's id returns 403 or 404, malicious input rejected with 400).
- Record recurring weaknesses for this repo in the Brain so future insects check them.

## Output

Use the code-review format, adding the vulnerability class:

```
src/api/files.ts:31: critical: path traversal (CWE-22). `name` from query joined into path unchecked; "../../etc/passwd" reads outside uploads. Resolve the path and reject anything not under UPLOAD_DIR.
```

Critical findings get a short paragraph: attack scenario, impact, fix. End with:

```
scans:   <tools run and results, or "unavailable: <why>">
checked: <checklist areas reviewed> | not applicable: <areas>
risk:    <what could not be verified>
verdict: approve | changes-requested | block
```

Block on any critical. Request changes on any high.

## Done when

- [ ] Trust boundaries of the change listed and each relevant checklist area walked.
- [ ] Available scans run, or marked unavailable.
- [ ] Every finding has line, attack, fix; no secret values reproduced.
- [ ] Critical findings escalated; verdict recorded in the card result.
