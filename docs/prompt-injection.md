# Prompt-injection signals

`PromptInjectionScanner` is a lightweight, deterministic scanner for instruction-like patterns in untrusted text. It normalizes Unicode, case, and whitespace, applies a small registry of understandable indicators, computes a SHA-256 content hash, and returns structured diagnostic signals. It runs locally without model inference, network access, or additional runtime dependencies.

> PromptInjectionScanner is a diagnostic heuristic, not a security boundary.

> Permission and policy enforcement remain authoritative.

## Scope

The scanner follows the existing prompt provenance names:

- `user_input`;
- `tool_output`;
- `mcp_output`, which includes MCP tool output and resources entering the prompt boundary;
- `child_output`.

It recognizes this deliberately small initial taxonomy:

| Category                         | Diagnostic meaning                                                                |
| -------------------------------- | --------------------------------------------------------------------------------- |
| `instruction_override`           | Attempts to replace, disregard, or supersede earlier instructions                 |
| `authority_impersonation`        | Claims system, administrator, root-agent, or equivalent authority                 |
| `policy_disable_attempt`         | Requests disabling, bypassing, or skipping permission, policy, or security checks |
| `secret_exfiltration_request`    | Requests disclosure or transmission of secrets or protected context               |
| `tool_activation_request`        | Directs the agent to activate a privileged shell, command, or administrative tool |
| `unknown_suspicious_instruction` | Strong agent-directed instruction that does not fit a more specific category      |

The scanner returns one aggregated signal per scanned value. A signal contains the source, categories, highest matched severity, stable indicator IDs, a content hash, and detection time. It does not include the raw untrusted payload.

## Prompt processing and traces

`SystemPromptProcessor` scans values while adding their existing `untrusted` layers. It does not remove, rewrite, sanitize, or reclassify those values. `AgentRuntime` emits each resulting signal through the existing event bus before `prompt.assembled`:

```text
mcp.resource.received
security.prompt_injection.detected
  source: mcp_output
  severity: high
  categories: instruction_override, policy_disable_attempt
prompt.assembled
  trust: untrusted
```

The event type is `security.prompt_injection.detected`. Its payload contains indicator IDs and the content hash, not the full malicious text. Existing human and tree trace renderers display the source, severity, and categories.

## What the scanner does not do

Detection does not terminate a workflow, reject an input, block a tool call, deny delegation, change permissions, rewrite a prompt, or grant authority. `PermissionEngine` and `PolicyEngine` evaluate requested actions independently. A signal may provide evidence for an operator or future policy, but version 0.1 is observability-only.

The scanner never executes scanned text, passes it to a shell, or treats it as code. It does not call an LLM, embedding model, or external service.

## False positives and false negatives

Prompt-injection detection is heuristic:

- A detection does not prove that the content is an attack.
- No detection does not prove that the content is safe.

The initial rules avoid isolated keywords such as `system`, `admin`, `tool`, and `secret`. They look for instruction-like combinations and skip several obvious explanatory contexts. This reduces naive matches but cannot understand every quotation, language, obfuscation, indirect instruction, or adversarial mutation. Review signal provenance and the surrounding trace before drawing a conclusion.

MAWL does not claim to be prompt-injection-proof. Authorization, least privilege, typed actions, tool validation, sandbox boundaries, secret isolation, and audit evidence remain necessary even when the scanner reports no signal.
