# Contributing to Multi-Agent Workflow Lab

Thank you for improving MAWL. Contributions are especially useful when they add reproducible agent behavior, prompts, tools, MCP adapters, workflow scenarios, evaluators, or security tests.

By participating, contributors agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Development environment

Required:

- Node.js 22 or newer;
- pnpm 11 (the repository records the tested version in `packageManager`).

```bash
cd multi-agent-workflow-lab
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm build
pnpm test
pnpm demo
```

These commands assume an existing clone or an extracted release archive. The default suite and demo use deterministic mock providers, so no external API key is needed. Add the public clone URL after the maintainer publishes the repository.

## Project structure

- `packages/core` — schemas and shared contracts;
- `packages/runtime` — agent execution, tasks, delegation, scheduling, and replay;
- `packages/evaluation` — rules, assertions, scores, and comparisons;
- `packages/observability` — events, traces, metrics, budgets, approvals, and monitors;
- `packages/tools`, `packages/mcp`, `packages/sandbox` — controlled execution boundaries;
- `agents`, `prompts`, `workflows`, `scenarios`, `redteam` — declarative assets;
- `tests` — unit, security, lab, and end-to-end coverage.

See the [documentation index](docs/README.md) before changing a subsystem.

## Adding an agent

1. Add a YAML definition under `agents/`.
2. Use an existing, versioned `systemPrompt` or add a prompt asset.
3. Declare the minimum capabilities, tools, MCP servers, permissions, targets, and execution limits.
4. Add a deterministic workflow or test that proves both allowed and denied behavior where relevant.
5. Run `pnpm mawl doctor` to validate the registry.

## Adding or changing a prompt

Prompt assets require a stable ID, semantic version, owner, type, input schema, content, purpose, expected input/output, allowed actions, recommended capabilities, and known risks.

Changing content without changing the version is rejected when it conflicts with an already registered hash. Add or update prompt-quality coverage and never place secrets in prompt files or fixtures.

## Adding a workflow

Place executable YAML under `workflows/`. Keep objectives bounded, dependencies explicit, delegation paths allowlisted, and resource limits realistic. Positive examples should complete with `MockModelProvider`; negative examples must document their expected non-zero exit and guard condition.

For a declarative contract, add a YAML spec under `tests/specs/` and execute it with:

```bash
pnpm mawl test tests/specs/<name>.workflow-test.yaml
```

## Adding a tool or MCP connector

- Register tools through `ToolRegistry`; never bypass `ToolExecutor`.
- Declare input/output schemas, required permissions, risk types, risk level, timeout, size limit, and sandbox policy.
- Treat tool and MCP output as untrusted.
- MCP adapters should implement `McpConnection` or `McpConnector` and include a local/mock test path.
- External side effects require policy and replay tests; risky operations should include approval behavior.

## Adding an evaluator or monitor

Implement `RuleEvaluator` or `RuntimeMonitor` without granting runtime authority. Findings need stable codes, evidence, severity, and deterministic tests. Scores must remain explicitly diagnostic.

## Tests

```bash
pnpm test
pnpm test:lab
pnpm test:e2e
pnpm test:security
```

Tests must not require paid services, live credentials, or mutable external state. Prefer `MockModelProvider`, `ScriptedModelProvider`, `InMemoryMcpConnector`, `InMemoryStore`, and seeded fault injection.

Security-sensitive changes should test the allowed path, denied path, emitted evidence, cleanup, and resource boundary.

## Pull request expectations

- Keep changes focused and avoid unrelated refactors.
- Explain the behavior, threat/trust-boundary impact, and verification performed.
- Update README, docs, examples, schemas, and changelog when public behavior changes.
- Add tests for fixes and new behavior.
- Do not commit `.env`, credentials, runtime databases, trace logs, coverage, `dist`, or sandbox output.
- Confirm `pnpm typecheck`, `pnpm lint`, `pnpm build`, and `pnpm test` pass.

Use private disclosure for suspected vulnerabilities; follow [SECURITY.md](SECURITY.md).
