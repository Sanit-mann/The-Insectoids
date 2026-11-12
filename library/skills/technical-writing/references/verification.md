# Technical verification

Verify implementation claims and examples by default. Scale the effort to the change: a wording edit that keeps an already verified claim does not need a fresh audit.

## Inspect the repository

1. Identify the package and version the doc targets. Check manifests, workspace config and release context. The checkout, the installed dependency and the published release may differ.
2. Find relevant files by listing and searching exact symbols, option names or error strings. Start in the likely package. Skip generated output, vendored code and unrelated packages unless needed.
3. Trace the public import or re-export to its definition. Read the signature and implementation with enough context to see defaults, branches, validation and errors. A search hit or type declaration alone does not establish runtime behavior.
4. Read focused tests and maintained examples. Tests support a claim only within their scope. Missing tests do not prove a feature is unsupported; a mock does not prove an external service's behavior.
5. Follow helpers only as far as the claim needs. Stop when the claim and its qualifications are supported.
6. Validate with the smallest relevant existing check: a targeted type check, test or link check, not the whole suite.

Batch independent searches and reuse evidence across claims about the same API. Keep a compact record of paths, symbols, version and open questions. Recheck when the code, version or claim changes. If code and existing docs disagree, report the discrepancy; do not silently pick the version that suits the draft.

## Match evidence to the claim

| Claim | Evidence |
|---|---|
| Implementation behavior | Code, tests, version or commit |
| Supported public interface | Public exports and types for the target version, checked against official docs |
| Release status or availability | Official changelog and availability docs |
| Planned behavior | A spec, clearly labelled as a proposal |
| Performance or scale | Original measurements with method, workload and conditions |
| Another vendor's capability | That vendor's maintained docs |

A newer source is not automatically right if it covers a different version or environment. Do not add false precision: "up to" or "approximately" does not rescue an invented number. Keep metric, baseline, unit, workload and "vendor-reported" with every measurement. Distinguish latency from throughput, average from percentile, and relative change from percentage-point change.

## Names and old terms

Check the current name for the product and version documented. A rename does not mean the behavior is the same. Keep historical names where readers search for old errors or migrate from old versions, and give the verified replacement. Preserve official capitalization (for example npm and pnpm in lowercase).

## Qualify scope

Check plan, region, runtime, framework version, deployment type, permissions and feature status when they affect the claim, and keep the qualification beside the instruction. Distinguish supported behavior, defaults, optional configuration and behavior seen in one test. Do not generalize from one local run to all environments. Absence claims need evidence too: a failed search does not prove a feature does not exist. Keep roadmap promises out of descriptions of available behavior. For integrations, verify which package provides each capability.

## Code and commands

Before including a sample, check that:

1. The package, API, flags, imports and config keys exist in the target version.
2. The snippet uses the documented mechanism in the right file or execution context.
3. Required setup, dependencies, credentials and permissions are explained or linked.
4. Placeholders are recognizable, consistent and valid after substitution. Avoid forms the shell reads as redirection (`<name>`); prefer `your_project_id`.
5. Error handling and cleanup suffice for the task without burying the main point.
6. The surrounding text describes accurately what the code does and does not show.

A complete example must run in the stated environment. A partial one says which file it changes and what context it assumes. Never label pseudocode as ready to run. Mark illustrative output as such; never present it as a test result.

## SDK behavior

Check the installed or targeted version before using a signature. Verify overloads, generics, optional arguments and return types when they affect the example. Do not infer runtime validation from types alone. For async APIs, say whether a call returns a value, promise, stream or subscription, when work starts, how completion and errors are observed, and cancellation or retry behavior when supported. For stateful APIs, say what persists, who owns it and how concurrent calls behave. For callbacks and events, verify payload, ordering and whether handlers can run more than once. In full-stack examples, keep private credentials on the server and mark the server and client boundary.

## Validation and reporting

Use the smallest meaningful check: syntax, compile, a focused test, a link check, or a safe run of the documented path. Never run destructive actions, spend money or publish content just to validate prose without approval. Record what ran, the relevant version and the actual result. If you could not run it, say so. Never invent a successful result or an exact error string.

Link the specific page or stable code revision that supports each claim. Paraphrase sources; quote briefly only when wording matters. Keep research history out of the published doc and list unresolved claims in the handoff.
