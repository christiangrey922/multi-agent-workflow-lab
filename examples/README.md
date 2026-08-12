# Examples

The primary release examples live under [`../workflows/`](../workflows/) and are documented in the root [README](../README.md). They run through the `mawl` CLI with the deterministic mock provider.

```bash
pnpm demo
pnpm demo:parallel
pnpm mawl run workflows/01-basic-delegation.yaml
```

Expected output includes a completed run status, task-to-agent assignments, a diagnostic delegation score, metrics, and a local trace path. Negative workflows under `workflows/` intentionally return a non-zero exit when permission, loop, or budget controls stop the request.

## Compatibility workflow fixtures

`examples/workflows/basic.yaml` demonstrates bounded fan-out and fan-in. `examples/workflows/security-test.yaml` is the workflow shell used by the adversarial security demonstration.

```bash
pnpm mawl run examples/workflows/basic.yaml
pnpm security:demo
```

The security demo uses synthetic hostile MCP/tool content and local adapters. It requires no API key and must never be modified to contain real credentials.
