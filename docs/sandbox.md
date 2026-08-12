# Sandbox

`RestrictedLocalSandbox` is a process-isolation adapter. It enforces an executable allowlist, explicit environment-variable allowlist, timeout, maximum captured output, workspace-relative filesystem policy, traversal checks, encoded traversal checks, and realpath-based symlink escape checks.

## Guarantee levels

| Control                       | Local provider guarantee            |
| ----------------------------- | ----------------------------------- |
| Command allowlist             | Enforced before spawn               |
| Environment allowlist         | Enforced before spawn               |
| Working-directory containment | Enforced with resolved paths        |
| Traversal/symlink escape      | Enforced for provider-checked paths |
| Timeout/output cap            | Enforced by process APIs            |
| Filesystem syscall isolation  | Not provided                        |
| Network isolation             | Best effort only                    |
| Kernel/container boundary     | Not provided                        |

The local provider must not be represented as a secure container. `networkEnforcement: best_effort` is returned explicitly because Node process spawning alone cannot guarantee egress blocking. Network-sensitive tools should use a container or stronger sandbox.

`DockerSandbox` is an optional adapter surface with an availability probe. Execution remains disabled until deployment-specific mounts, user IDs, seccomp/AppArmor, resource ceilings, and networking are configured.
