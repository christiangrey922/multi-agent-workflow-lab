# Documentation

This index separates the one-minute project overview in the root [README](../README.md) from detailed design, trust-boundary, integration, and release documentation.

## Architecture and runtime

- [Architecture](architecture.md) — packages, runtime lifecycle, evidence model, evaluation, replay, and extension interfaces.
- [Runtime](runtime.md) — typed agent action loop, task scheduler, limits, and trace events.
- [Tools](tools.md) — tool manifests, validation, policy, execution, and audit.
- [MCP](mcp.md) — official transports, adapters, trust boundary, and in-memory testing.
- [Replay](replay.md) — exact, dry-run, model-rerun, tool-rerun, and side-effect safety.
- [Model provider integration](provider-integration.md) — optional OpenAI-compatible adapter.

## Identity, policy, and isolation

- [Authentication](authentication.md) — principals, credentials, sessions, local API keys, and OIDC interface.
- [Permissions](permissions.md) — explicit grants, delegation reduction, and default deny.
- [Sandbox](sandbox.md) — local process and optional Docker provider boundaries.
- [Security model](security-model.md) — core trust assumptions and limits.
- [Threat model](threat-model.md) — assets, threats, controls, residual risk, and invariants.
- [Security implementation notes](security.md) — concise hostile-input assumptions.

## Prompts and inputs

- [Prompt processing](prompt-processing.md) — registry versions/hashes, strict variables, provenance, and trust layers.
- [Input parsers](input-parsers.md) — JSON, YAML, Markdown, text, and structured-task normalization.

## Testing and release

- [Testing and observability](testing.md) — evaluators, assertions, scenarios, faults, metrics, budgets, and production integration.
- [Repository capability matrix](../REPOSITORY_CAPABILITIES.md) — implemented, partial, and future capabilities.
- [v0.1.0 release notes](releases/0.1.0.md) — highlights, limitations, and getting started.
- [v0.1.0 verification](releases/0.1.0-verification.md) — executed checks, demo evidence, and release decision.
- [Release checklist](RELEASE_CHECKLIST.md) — local verification and manual publication gates.
- [Repository metadata](REPOSITORY_METADATA.md) — recommended GitHub description, topics, and announcement copy.

## Community

- [Contributing](../CONTRIBUTING.md)
- [Security policy](../SECURITY.md)
- [Code of Conduct](../CODE_OF_CONDUCT.md)
- [License](../LICENSE)
