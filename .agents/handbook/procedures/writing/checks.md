# Check the promised behavior

Choose evidence from the procedure's outcome. A source check can prove that a command accepts an option; only execution can show its observed effect in an environment. An artifact inspection and a user-flow check may both be needed for the same delivery.

Record the exact input, source or artifact, configuration, identity, environment, time, expected result, observed result and interpretation limit. Keep secrets out of records while retaining useful non-secret metadata and failure details.

Include a check for the failure or recovery behavior that the procedure introduces. Use an isolated case within existing authorization. A procedure for restoring retained data needs read-back through the consuming application; a successful restore process alone leaves that behavior untested.

Keep states separate: prepared, built, published, configured, running and accepted. Name skipped, blocked and unavailable checks precisely. Do not promote an example's expected output into an execution receipt.

Use the [acceptance template](../../project/acceptance.md) for the actual user action and the [service template](../../project/services.md) for external dependencies. Keep one owner for each record rather than creating duplicate status tables.
