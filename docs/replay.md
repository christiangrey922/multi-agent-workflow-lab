# Workflow replay

`WorkflowReplayEngine` operates on recorded runtime events and supports four modes.

| Mode          | Behavior                                               | Executes external work? |
| ------------- | ------------------------------------------------------ | ----------------------- |
| `exact`       | Reconstructs recorded task states                      | No                      |
| `dry-run`     | Inspects the trace and planned replay without adapters | No                      |
| `model-rerun` | Calls only the injected model rerun callback           | Model callback only     |
| `tool-rerun`  | Calls only the injected tool rerun callback            | Conditional             |

Tool rerun classifies write, delete, send, create, update, payment, publish, shell, and manifest-declared `external_side_effect` operations as risky. The engine blocks those calls unless `sideEffectPermissions` contains the exact tool name. The CLI supplies no side-effect permissions.

```bash
pnpm mawl replay <run-id> exact
pnpm mawl replay <run-id> dry-run
```

Production adapters should also isolate replay environments, use idempotency keys, enforce fresh authorization, and distinguish simulation endpoints from live endpoints. Replay safety cannot make an inherently non-idempotent third-party operation harmless.
