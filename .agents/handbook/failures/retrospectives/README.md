# Review the decisions that produced the result

Use a retrospective after a material failure or repeated operational friction. Reconstruct the decisions from their available evidence and distinguish incorrect assumptions, external constraints, changed requirements and unknown causes.

Skills: `review-code`.

Ask which contract was assumed, which consumer was actually tested, which state was visible at the time and which prerequisite appeared too late. Trace whether source, published artifact, active configuration and accepted user action were treated as if they were the same stage.

Check whether recovery preserved generated identities and partial effects, whether a retry repeated unrelated work, and whether a handoff retained the actual next action. For tooling changes, check whether a claimed speedup preserved the complete work inventory and required release protections.

Turn each selected lesson into one owned improvement with observable closure. Keep the [incident record](../../project/incidents.md) and current procedure connected. A retrospective is evidence about its recorded case; it does not become a mandatory checklist of every failure for every task.
