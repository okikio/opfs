# Upgrade a dependency or upstream artifact

Start from the actual owner: package, executable, image, generated client, shared tool or maintained application source. A proposed version update is evidence of an available change; it does not prove compatible integration.

1. Record the current and proposed immutable identities, publication state and relevant upstream changes.
2. Compare public APIs, configuration, behavior, data compatibility, target support and license or edition requirements.
3. Keep coupled protocol, image or package changes in one compatible cohort when their contracts require it.
4. Apply real source integration for an owned fork or import. Preserve true ancestry where it exists; use an explicit import record where it does not.
5. Migrate affected consumers, tests, documentation, generated files, configuration and recovery paths.
6. Run a frozen or equivalent reproducible dependency preparation and inspect the actual installed artifact.
7. Verify the changed behavior through the relevant consumer. Use a preview and promotion only when the delivery outcome requires them.

Treat shared task packs and tooling includes as versioned interfaces. Copying a command from another revision can mix incompatible contracts. Check the selected source and supported runtime before changing invocation shapes.

Verify publication separately from source. Before a consumer relies on an export, establish that the intended release contains it and is accessible to the consumer's identity. Before deployment, establish that the exact artifact exists for the required platform.

Keep a reviewable recovery path. Scanner exceptions and temporary workarounds need the actual exposure, owner and revisit condition. A prior project's exception is not a reusable default.
