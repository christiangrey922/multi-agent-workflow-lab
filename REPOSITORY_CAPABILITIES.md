# Repository capability matrix

Status reflects the v0.1.0 release candidate and describes local implementation, not production deployment guarantees.

| Capability                 | Status          | Notes                                                                                                         |
| -------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------- |
| Agent runtime              | Implemented     | Typed actions, bounded turns/errors/retries/tokens/time/output, cancellation                                  |
| Task graph and scheduler   | Implemented     | Dependencies, fan-out/fan-in, deterministic ready batches, cancellation propagation                           |
| Delegation                 | Implemented     | Parent/child identity, target/capability policy, depth/fan-out/task limits, loop checks, integration evidence |
| Tool execution             | Implemented     | Registry, schemas, allowlists, permissions, contextual policy, approval, limits, redaction, audit             |
| MCP                        | Implemented     | Official stdio and Streamable HTTP client adapters; in-memory mock connector                                  |
| Sandbox                    | Partial         | Restricted local process adapter and Docker interface; no hardened container/VM isolation by default          |
| Authentication             | Partial         | Static development and hashed local API-key providers; OAuth/OIDC is an integration interface                 |
| Permissions and policy     | Implemented     | Explicit grants/denials, deny-by-default evaluation, child authority reduction                                |
| Secrets and context        | Implemented     | Secret references, redaction, classified envelopes, protected/secret omission by default                      |
| Prompt registry            | Implemented     | Semantic versions, SHA-256 hashes, strict variables, metadata, provenance, trust layers                       |
| Input parsers              | Implemented     | JSON, YAML, Markdown, text, structured-task normalization                                                     |
| Observability              | Implemented     | Events, JSON logs, traces, graph, metrics, monitors, local persistence                                        |
| Evaluation                 | Implemented     | Nine deterministic rules, eight dimensions, assertions, YAML specs, optional model/mock judges                |
| Usage and cost             | Implemented     | Provider-neutral usage and externally maintained pricing-table estimates                                      |
| Budgets                    | Implemented     | Workflow resource budget plus task and agent execution ceilings; local counters                               |
| Human approval             | Implemented     | Provider interface, CLI provider, deterministic auto-approve/deny; no hosted approval UI                      |
| Replay                     | Implemented     | Exact, dry-run, model-rerun, guarded tool-rerun                                                               |
| Scenario and fault testing | Implemented     | Scripted behavior and deterministic seeded faults                                                             |
| Security tests             | Implemented     | Forty dedicated security tests plus red-team and end-to-end coverage                                          |
| Real model provider        | Partial         | OpenAI-compatible adapter available; CLI defaults to mock and does not load credentials                       |
| Distributed runtime        | Not implemented | Future extension; no queue or multi-node coordination                                                         |
| Remote telemetry backend   | Not implemented | Event/export interfaces exist; no bundled OpenTelemetry exporter or hosted service                            |
| Web UI                     | Not implemented | CLI, JSON, text tree, and Mermaid output only                                                                 |
| npm publication            | Not configured  | Workspace is source-release oriented and root package remains private                                         |
