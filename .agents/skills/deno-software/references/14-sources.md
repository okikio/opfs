# Deno Source Policy

Deno changes quickly enough that version-sensitive behavior must come from current primary sources. Use repository evidence first for what the project actually selects, then current Deno documentation for the runtime contract.

## Source order

Use this order for a Deno decision:

1. **Current repository evidence**: `deno.json(c)`, `package.json`, lockfiles, workspace files, tasks, CI, source imports, tests, and generated artifacts.
2. **Current official Deno documentation** for APIs, configuration, permissions, workspaces, Node/npm compatibility, publishing, and commands.
3. **Current Deno release notes** when the question depends on when behavior changed or which version introduced it.
4. **Upstream package documentation/source** for third-party packages used through npm, JSR, or URL imports.
5. **Issues and discussions** for unresolved interoperability or implementation gaps, clearly labeled as such.

Do not let an old repository comment override current tested behavior. Do not let current generic documentation override a repository pinned to an older runtime without checking the version requirement.

## Record version-sensitive claims

For any material external claim, capture enough evidence to answer:

```text
What exact behavior is claimed?
Which Deno version does it apply to?
Which official source establishes it?
Does the repository pin or require that version?
What command or fixture verifies it here?
```

Examples of version-sensitive areas include:

- workspace/config inheritance;
- `package.json` and npm lifecycle behavior;
- TypeScript/compiler-option support;
- permission grammar;
- `deno compile`, `deno bundle`, and desktop behavior;
- `Deno.serve` defaults;
- JSR/npm publishing rules;
- lockfile and dependency-age policy.

## Distinguish documentation status

Use precise evidence labels:

- **normative**: a standard or repository rule intentionally defines the contract;
- **observed source**: current official docs/source show the behavior;
- **executable**: a command or fixture proves the behavior in the inspected environment;
- **experimental**: an unstable API or feature is available but not a stable contract;
- **unresolved**: primary sources or runtimes disagree, or the needed environment cannot verify it.

Do not turn experimental or unresolved behavior into an unconditional recommendation.

## Repository source is not release history

A repository can contain compatibility code for versions it no longer supports. A current release note can describe behavior the repository cannot yet use. Check both directions before changing minimum versions or deleting compatibility paths.

## Ecosystem research

When a Deno package depends on a broader ecosystem, inspect the exact package and the owning repository or organization when that context affects the decision. Do not install sibling packages merely because they share an organization.

Use `explore-ecosystems` when the task becomes a real ecosystem comparison or dependency-selection investigation rather than a Deno-runtime question.

## Source hygiene

- Preserve exact API, option, and package names.
- Record publication/release dates when recency changes the conclusion.
- Avoid copied search snippets as evidence when the primary page is available.
- Separate implemented behavior from planned or issue-discussion behavior.
- Do not cite a secondary article for a contract that the official docs or source define directly.
- If current verification is unavailable, state the missing gate explicitly.

A Deno recommendation is ready only when its repository evidence, current runtime documentation, and validation plan agree.
