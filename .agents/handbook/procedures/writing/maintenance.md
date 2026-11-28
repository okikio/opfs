# Repair the instruction and its consumers

When a procedure causes or exposes a failure, identify the authoritative contract and every maintained consumer of it. Inspect configuration schemas, defaults, task wrappers, examples, setup instructions, recovery paths and acceptance tests.

Update those consumers together. Distinguish a broadly valid default from a host-specific requirement. Keep temporary investigation commands in evidence unless they become a recurring supported operation with an owner.

Recheck the failed action and then exercise a fresh configuration without relying on the repaired instance's local override. Record whether the procedure was reviewed, locally tested or rehearsed through the full journey.

Retain an incident's symptom, earliest cause, confidence, repair, prevention control and residual limit. Link the [incident record](../../project/incidents.md) to the changed procedure. Assign a completion condition that another maintainer can check.

Keep entry documentation and agent routes connected to the current procedure. Retire superseded instructions only after the active references have migrated; preserve historical evidence separately from operative guidance.
