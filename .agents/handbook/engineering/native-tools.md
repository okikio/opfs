# Inspect native capabilities before adding custom tooling

Read the installed version, current help, task source and actual output of the relevant tool. Check supported discovery, dependency selection, sharding, caching and packaging before implementing another mechanism.

For a proposed replacement, compare the current and native paths using the same inputs and expected results. Inspect semantic differences such as ignored files, target features, permissions, generated definitions, test discovery and failure exits.

A dependency or command name is insufficient evidence of support. Run the smallest representative operation, inspect its artifact or output and identify the remaining gap. Preserve the current implementation until its actual consumers can migrate safely.

Use the native runtime's manifests and lifecycle contracts. Keep orchestration thin and avoid parallel implementations of package selection, lock resolution or build state. When an adapter is justified, document the specific missing behavior and test the integration it supplies.

Keep user-facing command names and supported options grounded in the target repository. Do not copy another project's task family, runner label or cache configuration without checking the current contract.

## Let the package tool select its members

Member manifests own their package tasks and dependencies. Root tasks and Mise,
when selected, compose or forward to those owners. Keep a few stable task
families with arguments instead of adding a task for each current package or
test file. Let the package tool select members and the test runner discover
files within them.

| Need | Native capability to inspect |
| --- | --- |
| Select Deno workspace tasks | `deno task --filter <member-selector> <task>` selects member names. Use `--cwd` when selecting a known directory is clearer. |
| Select pnpm workspace scripts | `pnpm --filter <selector> run <script>` supports package names, patterns, paths and dependency relationships. |
| Select tests within a scope | Use that runner's file discovery or test-name filter. `deno test --filter` filters test names; it does not select workspace packages. |

Real package names are one useful selector, not a required naming style for
examples or commands. Use the project's actual names, supported patterns or
paths as appropriate. Do not strip a scope, scan folders or synthesize a path
from a package name when native selection already expresses the operation.
Verify the selected members and argument forwarding against the pinned tool.

## Prove required work before retiring a wrapper

Check an exact selection, an empty selection, a missing task, a mixed selection
where only some members define the task, and a failing task. Include dependency
order, concurrency, cancellation and cleanup when the old wrapper owns those
behaviors. New, nested, moved and removed members must enter the native inventory
without another hard-coded list.

Use native strict options where available. For pnpm,
`--fail-if-no-match` rejects an empty package selection; it does not prove that
every selected package defines the requested script. Recursive execution can
skip members without that script. Do not use an optional-task flag such as
`--if-present` when the task is required. Check the current tool's behavior and
record which required member tasks actually completed instead of inferring
coverage from exit status alone.

Move package work into its member task before removing a dispatcher that was
its only implementation. Migrate callers, CI, task inputs, generated artifacts,
help and docs together. Keep any demonstrated affected-work or cache policy
with its real owner; removing duplicate discovery does not remove that policy.

The [Deno task](https://docs.deno.com/runtime/reference/cli/task/),
[Deno test](https://docs.deno.com/runtime/reference/cli/test/),
[pnpm filtering](https://pnpm.io/filtering) and
[pnpm run](https://pnpm.io/cli/run) references describe distinct selection
contracts. Recheck their relevant options against the installed version before
using them in a repository task.
