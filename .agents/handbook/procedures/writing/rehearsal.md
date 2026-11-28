# Rehearse without relying on hidden setup

Use a fresh or appropriately isolated environment to expose prerequisites that an existing installation may hide. Select the smallest rehearsal that can test the changed contract and remain within authorized effects.

Have the intended operator follow the instructions when practical. Record undocumented intervention, unclear output, unavailable controls and incorrect assumptions. A second reader can find gaps through source review even when runtime access is unavailable; record that review's limits.

Choose a meaningful failure branch, such as missing access, an interrupted job or a rejected input. Preserve partial state and verify the documented recovery. Avoid unrelated expensive stages when the failed contract can be exercised directly.

After the rehearsal, check the final user action and cleanup. Retain the source revision, environment, observations and interventions. A procedure that works once in an operator's configured environment does not establish fresh-install behavior elsewhere.

Repeat only checks invalidated by a correction. If a required rehearsal remains blocked, name its missing prerequisite and owner instead of claiming the procedure has been exercised.
