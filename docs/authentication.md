# Authentication

The auth package distinguishes four records: `Principal` (user, agent, service, MCP server, or tool identity), `Credential`, bounded `Session`, and `AuthContext`.

`LocalApiKeyAuthProvider` stores only salted SHA-256 API-key hashes and compares candidates with a timing-safe operation. Raw keys are not persisted. It is suitable for local development; production deployments should replace it with a hardened KDF or managed identity system as appropriate.

`OAuthOidcAdapter` defines authorization URL, code exchange, and optional refresh integration without hard-coding an external provider.

Agent executions receive a distinct `ExecutionIdentity` (`agent:<id>`) linked to workflow, task, execution, and originating session IDs. This prevents user identity and delegated agent authority from being conflated in audit records.
