# Testing and observability lab

Deterministic tests are the source of truth for enforceable behavior. Model-based judgment is optional and must never grant authority.

## Evaluation

`DelegationEvaluator` runs depth, permission escalation, context leak, tool policy, retry storm, duplicate task, loop, budget, and capability rules. It returns eight dimension scores, violations with evidence, recommendations, version, and `diagnosticOnly: true`. `LLMJudgeEvaluator` accepts any `ModelProvider`; `MockJudgeEvaluator` is the no-key local implementation.

## Test surfaces

- `expectWorkflow`, `expectAgent`, and `expectTask` provide fluent positive/negative assertions.
- `WorkflowSpecRunner` loads YAML contracts such as `tests/specs/basic.workflow-test.yaml`.
- `ScenarioRunner` combines scripted behavior and seeded `FaultInjector` rules.
- Faults cover timeout, malformed output, disconnect, generic error, permission denial, prompt injection, network loss, and sandbox termination.
- `RunComparator` reports output, agent, delegation edge, tool, denial, time, token, task, failure, and score changes.
- `PromptRegressionEvaluator` ties prompt version/hash changes to comparative run metrics.
- `PromptQualityValidator` detects duplicate IDs, invalid versions, missing metadata/variables, unresolved placeholders, and unknown agent/tool references.

## Observability and cost

Events are the canonical audit evidence. Trace trees and Mermaid graphs are derived views. Metrics include workflow/agent duration, delegation count/depth, tool calls/failures, permission denials, sandbox failures, tokens, tasks, and retries. `UsageTracker` uses provider-neutral pricing entries; prices are operator data, not hard-coded truth. See `config/pricing.example.yaml`.

`BudgetEnforcer` supports termination or approval requests at workflow level. Task execution budgets and agent execution limits form lower-level ceilings. In distributed deployments, replace local counters with atomic shared accounting.

## Production integration

Replace the mock model with `OpenAICompatibleProvider`, in-memory store with a durable implementation, `AutoApproveProvider` with a human/workflow approval adapter, local sandbox with a hardened container/microVM provider, and local logs with an OpenTelemetry/export pipeline. The interfaces, local implementations, tests, and security limitations remain the same.
