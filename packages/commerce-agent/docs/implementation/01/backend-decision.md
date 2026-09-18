# ADR: Restricted single-turn model driver

Status: accepted for chain 01.

## Decision

The commerce runtime uses a package-owned investigation loop over a `ModelTurnPort`. The live implementation delegates one generation turn to `@earendil-works/pi-ai`; it does not give the model an executable callback. A separate dispatcher validates the full proposed tool batch, injects trusted task scope, enforces a nine-tool allowlist, and then calls the commerce MCP server.

The general coding-agent backend was not used as the security boundary because its internal loop and coding tools make per-turn commerce budget and dispatch control less explicit. This is a local architecture choice; it does not modify global coding-agent permissions.

## Boundaries

- Live and fake modes are explicit and recorded in the manifest. Live failures never fall back to fake.
- `maxRetries` is zero at the model layer. MCP retries report their physical attempt count to the host budget.
- Model-visible tools exclude shell, file access, proposal approval, and execution.
- The MCP child receives an explicit environment only. Parent provider credentials are not inherited.
- A report becomes successful only after `validate_report` persists it and the host reads it back with matching task, trace, and shop scope.

## Known limits

The live provider path is code-complete but was not called in this run because no explicit model connection and budget were supplied. SQLite and fixture data are an engineering harness, not a claim of production tenancy or real merchant data. Multi-worker recovery remains chain 04.
