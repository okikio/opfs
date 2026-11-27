# Adopt the guidance in an existing project

Adoption should make the next real task easier to perform and verify. Begin with the target repository's current instructions, source revision, local changes, installed guidance and task commands. Preserve existing decisions that still apply.

## Choose an installation form

The collection's authored skills link to shared guides, references and this handbook. Keep those dependencies together when using the source collection. For installation of an individual skill, use a generated self-contained bundle produced by the repository's documented packaging workflow. Verify the bundle's actual contents and links before relying on it.

Use the collection's [self-contained bundle instructions](https://github.com/okikio/skills#install-a-self-contained-skill-bundle) for supported packaging and installation commands. A plain directory copy of a source skill does not include shared files outside that directory. Saving documents also does not prove that an agent host loads them.

For a whole-collection adoption:

1. Record the current repository, branch, revision and uncommitted work. Compare the proposed guidance with existing rules and earlier versions by content and ancestry.
2. Choose the applicable capabilities and preserve their complete document dependencies. Keep one authored owner for each shared rule.
3. Merge the [routing fragment](start/agents-fragment.md) into the project's existing instruction surface. Resolve its paths against the actual installation.
4. Fill the relevant [project profile](profiles/project.md) fields using verified source, commands and supported environments. The [generic profile](profiles/generic.md) supplies the defaults.
5. Bind the selected procedures to the project's real commands, inputs and expected results using the [command record](project/commands.md). Proposed command names must not appear as implemented instructions.
6. Check links, skill metadata, resource availability and the produced installation. Start a fresh host session and run a small representative task through the installed route.

## Verify a useful task and a failure branch

Choose a low-cost question that the project can answer with a real operation. Confirm that the agent locates the current source, identifies the affected capability, loads its shared method and uses the existing tooling. Inspect the output and the evidence behind its decision.

Then use a bounded case with an unavailable prerequisite or unexpected result. The agent should preserve the observation, keep the original question open when necessary, and select a valid next step. It should not invent a command, claim that documentation executed, or introduce unrelated infrastructure.

Record source review, installation checks and observed task behavior separately. These checks cover the tested host and scenario. Repeat the relevant checks when the host, packaging mechanism, shared resources or activation contract changes.

## Maintain one connected source

Update the owning guide or reference first, then its routes, generated bundles, examples and applicable evaluations. Keep generated copies reproducible. Retire obsolete entrypoints only after their current consumers have migrated.

Keep project facts in project records. Keep reusable methods in the collection. Historical reports, private incident evidence, credentials and session-specific storage links do not belong in a public guidance package.
