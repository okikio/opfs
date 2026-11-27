# Find the existing owner before adding a capability

Start with the operation the caller needs. Search current source, aliases and real callers. Inspect the owning export map, implementation, tests and installed version before introducing a wrapper or local replacement.

Trace generic mechanics, product policy, service contracts and execution hosts as separate responsibilities. A CSV read needs a parser and input contract; a durable export may also need persistence and recovery. Choose the smallest existing capability that supplies the required behavior and lifetime.

For each candidate, establish:

- Its public entrypoint and actual resolved source or release.
- The inputs, outputs, errors and unsupported cases relevant to the caller.
- Ownership of resources, cancellation and cleanup.
- Supported hosts, dependency cost and data or security constraints.
- The consumer test that can confirm the material claim.

Use [use-utils](../../skills/use-utils/SKILL.md) when the project selects the corresponding public utility packages. Use [use-okikio](../../skills/use-okikio/SKILL.md) for its distinct library ecosystem. A similar package name does not prove identical exports or publication status.

Keep a native command when its authentication, plugin, state or saved-plan semantics are the supported interface. An SDK is useful when it owns the required protocol correctly. If generation is necessary, identify the specification revision, generator, published artifact owner and real consumer test. Do not fabricate generated files or locks to bypass an unavailable build environment.

When no existing capability fits, record the missing behavior and put the change with its natural owner. A new fork, shared package or adapter needs an upgrade path and a reason it cannot remain a small project-specific operation.
