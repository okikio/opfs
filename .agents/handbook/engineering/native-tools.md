# Inspect native capabilities before adding custom tooling

Read the installed version, current help, task source and actual output of the relevant tool. Check supported discovery, dependency selection, sharding, caching and packaging before implementing another mechanism.

For a proposed replacement, compare the current and native paths using the same inputs and expected results. Inspect semantic differences such as ignored files, target features, permissions, generated definitions, test discovery and failure exits.

A dependency or command name is insufficient evidence of support. Run the smallest representative operation, inspect its artifact or output and identify the remaining gap. Preserve the current implementation until its actual consumers can migrate safely.

Use the native runtime's manifests and lifecycle contracts. Keep orchestration thin and avoid parallel implementations of package selection, lock resolution or build state. When an adapter is justified, document the specific missing behavior and test the integration it supplies.

Keep user-facing command names and supported options grounded in the target repository. Do not copy another project's task family, runner label or cache configuration without checking the current contract.
