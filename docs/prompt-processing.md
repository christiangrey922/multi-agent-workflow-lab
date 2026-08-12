# Prompt Processing

`SystemPromptProcessor` makes prompt construction an explicit trust boundary. Runtime policy, security policy, registered agent prompt, workflow instructions, and task instructions are trusted layers. User input, tool output, MCP output, and child output are serialized inside marked `untrusted-data` layers with source, version, hash, and provenance.

Layer ordering is immutable within the processor. Untrusted text cannot replace or mutate the runtime/security layers; it remains data supplied beneath them.

`PromptRegistry.renderStrict` rejects missing and unexpected variables, wrong declared types, oversized variables, unresolved placeholders, content-hash mismatches, and changes without a version bump. Prompt assemblies record layer hashes and a hash of the final rendered prompt.

Prompt injection is not “solved” by a string filter. Detection indicators improve audit visibility, while authority remains controlled by typed actions, permission checks, policy checks, schema validation, and sandbox boundaries.
