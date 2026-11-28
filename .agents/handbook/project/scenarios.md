# Scale the records to the work

These are illustrative walkthroughs, not reports of executed projects. Each uses the same method with a different acceptance target.

## A library gains a streaming parser

The reader is a developer who needs to parse bounded chunks without retaining the whole input. Inspect the existing export, caller and ownership rules. Use a small fixture split at meaningful byte positions to compare streaming output with an independent expected result. Plan error, cancellation and resource limits before adding buffering abstractions.

The acceptance record names supported runtimes and tests the packaged public export. The ownership record explains who owns input buffers and when they may be reused. Delivery ends with the verified package artifact and documentation; no preview environment is required.

## A command-line tool changes configuration precedence

The operator needs explicit command-line values to override configuration without silently replacing omitted values. Trace parsing, environment sources, file loading, merge behavior and runtime defaults. Probe omitted, explicit, invalid and conflicting inputs through the existing command.

The plan changes the owning parser or resolver and its consumers. Acceptance checks stdout, stderr, exit status, help and the installed executable. The command record makes the actual invocation reproducible without imposing another task runner.

## An application adds a scheduled export

The customer needs a complete file at the promised time and a clear failure state. Trace scheduling, authorization, job ownership, artifact storage, notification and retrieval. Test the smallest uncertain mechanism first, then the integrated user path. Define duplicate execution, retries, cancellation and stale results where they matter.

The service record identifies required consumers and environments. A reviewer environment may provide feedback, followed by authorized promotion with compatible data and a recovery path. Acceptance ends at the user's usable result, while retirement separately accounts for temporary resources.
