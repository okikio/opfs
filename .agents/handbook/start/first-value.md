# Define the first useful action

A first useful action is the smallest complete use of the result that matters to its intended reader. It gives implementation and validation a common target.

For an application, a user may sign in, upload a file, receive a processed result and retrieve it later. For a library, a developer may install the package, call a public export with representative input and handle its documented failure. For an internal tool, an operator may inspect a proposed change and recognize when it is safe to apply.

Describe three connected views when the work spans several owners:

| View | Record |
| --- | --- |
| Customer or team | The problem, useful outcome and conditions that make it valuable. |
| User or caller | Starting state, actions, visible results, decisions and recovery options. |
| System | The owner of each step, data exchanged, state changes, external effects and failure handling. |

Keep one representative path traceable across these views. If an export is useful only when the file contains every requested record, the download button alone is not the acceptance target. If the task only reviews source, the target is an actionable, evidence-backed review; do not invent a deployment requirement.

Record the [exact acceptance action](../project/acceptance.md) before substantial implementation. Include the intended environment, identity, input, output and allowed side effects. Add a refusal, retry or cancellation case when it protects the changed contract.

Use this target to choose dependencies, experiments and verification. A change of outcome should update the plan and acceptance evidence explicitly, while preserving the observations already made.
