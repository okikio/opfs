# Choose the procedure for the task

Each procedure names a starting state, a useful result, the evidence to collect and the response to failure. Bind its actions to the target repository's supported commands. The procedures do not introduce a deployment system or authorize an external operation.

Skills: `plan-changes`, `build-data`, `build-devtools`, `release-software`, `verify-behavior`.

| When | Procedure |
| --- | --- |
| The source, outcome or environment needs clarification | [Open the project](intake.md) |
| A required service or consumer contract needs proof | [Verify service contracts](service-contracts.md) |
| A reviewer needs a working environment | [Deliver a preview](preview.md) |
| An authorized candidate is selected for production | [Promote the candidate](promotion.md) |
| Preparation, mutation, startup or acceptance fails | [Recover](recovery.md) |
| Temporary resources reach the end of their purpose | [Retire them](retirement.md) |
| A dependency, image, tool or upstream source changes | [Upgrade](upgrades.md) |
| Instructions are new, stale or incomplete | [Maintain the procedure](maintenance.md) |

The [playbook](../playbook.md) connects these procedures to research, implementation and handoff. Select only the branches required by the outcome. Use the [writing guidance](writing/README.md) when turning a project operation into maintained instructions.
