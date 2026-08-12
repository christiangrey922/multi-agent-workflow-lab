# Security model

MAWL assumes that agents, tool arguments, MCP responses, and model output can be hostile.

- Delegation and dangerous permissions are denied by default.
- A child receives the intersection of parent and child permissions.
- A child budget is clamped to the parent budget.
- Protected context is withheld. Secrets require explicit permission on both sides.
- Tools and MCP servers use independent allowlists.
- The reference process sandbox executes only allowlisted binaries in a disposable directory.
- Depth, child count, total tasks, retries, runtime, tokens, turns, and tool calls are bounded.
- Append-only events preserve denied requests and failures rather than hiding them.

The reference sandbox is a local-process isolation adapter, not a container or VM boundary. Production deployments should supply a stronger sandbox implementation appropriate to their threat model.
