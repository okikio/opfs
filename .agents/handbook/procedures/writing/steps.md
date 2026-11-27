# Pair each action with an observation

Start a step with the actor's action. State the target, input, working directory and relevant scope before showing a command. Explain what changes and what the operator should inspect afterward.

For a consequential step, answer four questions: what will run, what should be observed, what would make the result invalid, and what should happen next if it fails. Specify a bounded wait only when the operation has meaningful progress and timeout behavior.

Use actual commands from current help and source. Clearly mark values the operator must supply. Do not imply that a proposed command exists or use a secret value as an example. Keep standard input, output files, logs and credentials in their documented roles.

Separate observation from mutation. A read failure is not permission to initialize state. A timeout is not proof that a mutation stopped. An interruption branch should inspect actual state and account for effects already performed.

Put warnings at the decision they govern, with the concrete consequence and safe action. Repeated generic caution does not compensate for an ambiguous command or missing ownership check.
