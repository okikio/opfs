# Bind procedures to real commands

Verify each command against current help, source and a relevant consumer before using it as an instruction. Keep proposed operations clearly marked until implemented.

| Procedure action | Existing command or API | Working directory and inputs | Version and authority | Expected output or state | Failure, retry and cleanup |
| --- | --- | --- | --- | --- | --- |
| | | | | | |

Record the operation's target, identity role and allowed effects. Identify whether a plan is read-only, whether applying it mutates state, and whether a timeout can leave work running. Preserve the distinction between machine-readable output, diagnostics and secret input.

Use the repository's current task runner and argument contract. Do not assume that a wrapper forwards standard input, flags or exit status in the same way as its child command. Check help and behavior for the actual installed version.

Keep command bindings near the project that owns them. Generic handbook procedure names describe outcomes and do not assert a universal executable interface.
