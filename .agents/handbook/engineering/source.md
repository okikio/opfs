# Establish the source and complete work inventory

Start with one repository or explicit source set, a verified revision and a bounded outcome. Preserve local changes and identify concurrent work before editing shared task or build definitions.

Trace changed files through package exports, import relationships, generated output, test fixtures, configuration and release consumers. Include type-only dependencies, migrations, browser assets and shared tooling when they affect required work.

Keep a complete discovered inventory as the comparison oracle for selective execution. A tool that reports no affected tasks must explain why the changed input cannot affect a consumer. Unknown or incomplete relationships require a conservative scope.

Inspect the actual task owner, runner and cache layers before proposing another wrapper. Determine what is source, generated output, temporary evidence or published artifact. New and removed files must enter the same discovery and invalidation model as edited files.

Record the source identity and commands used for the baseline. A later integration or dependency change can invalidate a comparison even when the task name stays the same. Use the [engineering record](../project/ci.md) to connect the inventory to the proposed change and acceptance checks.
