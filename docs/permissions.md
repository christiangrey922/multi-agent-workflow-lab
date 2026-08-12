# Permissions

`PermissionEngine` combines RBAC, capability-style grants, ABAC conditions, action filters, and resource scopes. All unmatched requests are denied.

```mermaid
flowchart TD
  A[Principal request] --> B[Permission and resource match]
  B --> C[Role and action match]
  C --> D[ABAC conditions]
  D --> E{Explicit deny?}
  E -- Yes --> F[Deny]
  E -- No --> G{Explicit allow?}
  G -- Yes --> H[Allow]
  G -- No --> F
```

Deny wins over allow. Permission strings and resources support bounded glob matching. Conditions compare declared context attributes only.

Delegation is least-privilege intersection. A child can receive only permissions held by the parent and accepted by the child profile. Explicitly requested permissions are checked before child creation. `delegable: true` is required in the generic engine; an agent definition must also possess the requested permission. Budgets are clamped to the parent ceiling.

Every evaluation creates a `PermissionDecisionRecord` containing principal, permission, resource, action, result, reason, matched policy, and timestamp. Tool and runtime layers emit these records into the trace.
