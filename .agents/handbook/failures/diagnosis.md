# Find the earliest failure that explains the outcome

Begin with the exact user action and first failed operation. Preserve bounded output, source and artifact identity, environment, configuration and time. Inspect current state before changing it.

| Observation | Question to investigate |
| --- | --- |
| Dependency preparation fails | Is the version published, is the required export present, and can this identity fetch the artifact? |
| Local checks pass but runtime fails | Which environment, host, setting, process role or installed artifact differs? |
| Health passes but the action fails | Which downstream contract, background role, access decision or result step remains untested? |
| A mutation times out | What completed, what remains active, and which effects are still unknown? |
| A retry duplicates or loses work | What identifies the operation, owns its state and rejects stale or repeated effects? |
| A recovered instance works but new setup fails | Which default, example or instruction still depends on the old override? |
| CI is faster after a change | Did required work, discovered tests, output or release protection change? |
| A copied integration cannot run | Was the example's runtime, provider, package or platform assumption actually selected? |

Treat these as hypotheses to test. Separate observation, likely cause and confirmed cause. Repair the owner that explains the result before chasing later symptoms. Use an existing executable or artifact for the smallest valid check.

When the evidence cannot distinguish causes, record that uncertainty and choose the next discriminating observation. An environment limitation can be a complete finding without proving an application defect.
