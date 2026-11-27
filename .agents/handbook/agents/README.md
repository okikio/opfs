# Carry intent through execution and interruption

Keep the intended result, accepted decisions, actual state and next action usable throughout a long task. One compact active record should point to the full plan and evidence rather than compete with them.

Skills: `plan-changes`, `commit-changes`, `prepare-pull-requests`, `build-workflows`.

| Need | Read |
| --- | --- |
| Keep current task state | [Active record](task-record.md) |
| Establish access and report owner actions | [Access](access.md) |
| Avoid unjustified new infrastructure or scope | [Scope](scope.md) |
| Verify the action the user actually requested | [Acceptance](acceptance.md) |
| Coordinate parallel work and meaningful exits | [Milestones](milestones.md) |
| Retry without repeating unrelated work | [Retries](retries.md) |
| Resume from current source and actual state | [Resumption](resume.md) |
| Repair recurring instructions after a failure | [Closure](closure.md) |

These practices supplement the task's existing authority. They do not create a new approval policy, require a particular tracking system or establish that a runtime enforces the documented rules. Scale the record to the work; a small change needs a clear next action, not a collection of forms.
