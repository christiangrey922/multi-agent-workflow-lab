# Security Policy

## Supported versions

This is an experimental v0.1.x release candidate. Security fixes are applied to the latest source revision and most recent v0.1.x release only. No long-term support branch is currently maintained.

## Reporting a vulnerability

Do not disclose sensitive vulnerability details in a public issue, discussion, pull request, trace, or test fixture.

Use the repository's private vulnerability reporting feature or a draft GitHub Security Advisory when the repository is published. If private reporting is not enabled, contact a maintainer through an existing private channel and ask for a secure disclosure path. No security email is listed because none has been established.

Helpful triage information includes:

- affected revision, version, package, and adapter;
- threat actor and required access;
- minimal reproduction using synthetic data;
- expected and observed behavior;
- confidentiality, integrity, availability, or authority impact;
- whether secrets, external side effects, sandbox escape, or remote execution are involved;
- proposed mitigation, if known.

Remove real credentials, personal data, access tokens, and third-party secrets from the report. Maintainers should acknowledge receipt, reproduce and assess impact, prepare a fix and regression test, and coordinate disclosure before publishing details.

## Security boundaries

MAWL separates runtime identity, permissions, contextual policy, context transfer, tool/MCP execution, approval, sandboxing, redaction, and audit evidence. Unmatched authority is denied by default, and model/tool/MCP/child content does not grant permission.

The restricted local sandbox is a development adapter with process isolation and best-effort network controls. It is not a hardened container, VM, microVM, or kernel security boundary. Prompt-injection detection is heuristic. Production users must select deployment controls appropriate to their threat model.

Read the [threat model](docs/threat-model.md), [security model](docs/security-model.md), [permissions guide](docs/permissions.md), and [sandbox guide](docs/sandbox.md).
