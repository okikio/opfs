# Maintain procedures from observed use

A maintained procedure must help its intended operator recognize the starting state, carry out the supported action and distinguish success from an incomplete result. Review it after a changed contract, incident, missing step or failed walkthrough.

1. Trace the real operation, its state transitions and external effects.
2. Put prerequisites before the steps that need them and bind commands to current source or help.
3. Give each consequential action an expected observation and a failure branch.
4. Exercise the procedure in an appropriate isolated environment when authorized. Record undocumented interventions as defects.
5. Test a relevant interruption, refusal or recovery case when it affects the contract.
6. Verify cleanup and the promised user outcome independently.
7. Record the exact revision, environment, checks and remaining limitations.
8. Update the procedure, authoritative defaults, examples and automation together.

Source review, local execution, a preview rehearsal and production execution establish different evidence. Label the level actually observed. A document review can find missing prerequisites without proving that a live operation works.

Select rehearsals from the changed risk: fresh dependency preparation, artifact admission, initial creation, ordinary update, interrupted migration, data restore or setup after a repaired default. A disposable reset does not prove restoration of retained data. An existing production override does not prove fresh-install instructions are correct.

Use the [procedure-writing guide](writing/README.md) to improve the instruction itself. Repeated operator errors may call for a stronger invariant or simpler command, with prose reserved for the judgment the operation still requires.
