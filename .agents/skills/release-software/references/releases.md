# Releases

A release is the point where internal repository state becomes an external contract. Treat release preparation, release authorization, publication, and post-release verification as separate operations. A green build proves only that the candidate passed that build. It does not prove that the public registry, deployment target, upgrade path, or installed artifact works.

## Establish release authority

Before changing versions or publishing anything, identify:

- the exact package, application, service, image, extension, or workspace release set;
- the version source of truth and release policy;
- every registry, deployment environment, package index, or artifact store that will change;
- the branch, commit, and generated artifacts that define the candidate;
- the supported upgrade path from currently deployed or published versions;
- whether migrations, data changes, or compatibility windows are involved;
- the rollback, deprecation, or forward-fix strategy if only part of the release succeeds.

Publishing changes external state. Do not publish, push tags, deploy, notify users, mutate registries, or rotate release channels unless the task authorizes that action. Preparing a release candidate does not imply authorization to publish it.

## Build the release candidate from known source

A release candidate must be traceable to an exact source state. Record the commit or working-tree state, toolchain versions, dependency lock state, generated files, and build inputs that materially affect output.

For a workspace, determine the complete release set before changing versions. Check internal dependency ranges, peer relationships, package exports, generated manifests, and any release-order requirements. A package can be individually valid while the workspace release is impossible to install because one internal range still points at the old version.

Do not mix unrelated formatter, import-order, or generated-file churn into release preparation. If generated artifacts must change, run the owning generator and review the resulting diff.

## Readiness gates

Use the repository's real release gates. Typical evidence includes:

1. formatting and lint checks for the changed source;
2. strict type checks and public type-inference fixtures;
3. unit, integration, lifecycle, and runtime-specific tests;
4. browser or worker tests for browser claims;
5. benchmark or regression checks when performance is part of the contract;
6. generated-artifact freshness checks;
7. package or application builds;
8. package-content inspection;
9. clean-consumer installation and a representative supported workflow;
10. migration and rollback checks where state changes persist.

Do not replace a blocked native gate with a nearby check and call it passed. Report `blocked` with the missing runtime or dependency and the exact command that still needs to run.

## Inspect the artifact, not only the source tree

A release ships an artifact. Inspect the artifact the consumer will receive.

For packages, inspect the tarball or equivalent archive. Check:

- included and excluded files;
- public entrypoints and export maps;
- generated declarations and source maps;
- license and metadata;
- accidental fixtures, secrets, `.agents/`, local caches, or development output;
- runtime-specific files that should stay behind explicit subpaths;
- dependency and peer metadata.

For binaries, images, extensions, and deployable bundles, inspect the corresponding package contents, manifest, target architecture, permissions, and startup behavior. When checksums, signatures, provenance statements, or SBOMs are part of the release contract, validate them against the final artifact.

## Mutation preflight

Before the first external write, confirm:

- authenticated identity and target account;
- package scope, project, organization, and environment ownership;
- exact candidate version and whether the target version is still available;
- tag and branch protection rules;
- registry immutability and deprecation rules;
- secret and credential handling;
- user-visible messages, charges, migrations, or deployment effects;
- publication ordering for multi-package or multi-target releases;
- recovery from partial publication.

Never rewrite an immutable public version or destructively retag a released commit to hide a partial failure. If a registry or deployment platform makes publication irreversible, plan the forward-fix path before publishing.

## Publish in a controlled order

When packages depend on one another, publish in dependency order unless the release tooling owns a different proven strategy. For multiple targets, record each target result independently.

After every external mutation, capture the concrete result:

```text
package / service
version / revision
target registry or environment
published digest or immutable ID
public URL when applicable
status
```

If one target succeeds and another fails, the result is a partial release. Do not collapse that state into either total success or total failure. Report what is already public and what still needs a forward fix.

## Verify from the consumer side

A successful publish command is not the end of verification. Fetch or install the released artifact from the public target into a clean location. Do not reuse a local workspace link or cache when the real consumer will use the registry.

Run a representative supported workflow. For example:

- import the public package entrypoint and exercise a real API path;
- start the deployed application and execute its health/user flow;
- install the extension package and inspect the generated manifest;
- pull the published image by immutable digest and run its entrypoint;
- apply the released migration against a representative database and verify the resulting state.

Compare the public artifact with the candidate you intended to publish. A registry can accept a package that differs from the local build because of publish hooks, ignored files, generated metadata, or stale working output.

## Post-release evidence

Preserve the evidence needed to answer later questions:

- exact version and commit;
- artifact digests;
- registry or deployment identifiers;
- release notes and migration notes;
- checks that ran and their results;
- blocked checks that remain;
- partial-release recovery actions;
- links to monitoring, incidents, or follow-up fixes when relevant.

Communicate breaking changes and recovery steps when release communication is in scope. Keep the release report factual. Distinguish what was verified from what is expected based on tests or platform behavior.
