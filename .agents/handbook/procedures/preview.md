# Deliver a usable reviewer environment

Use a preview when the outcome requires human feedback from an isolated running application. A package or source-only task may instead deliver its verified artifact. Automatic preview creation is optional; a manually operated environment is usable when its identity and lifecycle are explicit.

Entry requires a defined journey, known candidate, relevant service evidence and a supported environment operation within the task's authorization.

1. Select the exact source, locks and effective build configuration. Reconcile concurrent changes before attaching evidence to the candidate.
2. Resolve or build the artifact. Inspect the installed package, executable or image that the runtime will consume.
3. Run the affected checks and required artifact operations. Distinguish source checks from startup and host behavior.
4. Allocate preview-specific data, identity and origin. Confirm how the preview avoids unintended production access and external effects.
5. Inspect and apply the environment's supported plan or deployment operation. Confirm ownership and the intended target.
6. Complete service checks that require the running application. Preserve their consumer and environment scope.
7. Complete onboarding and the agreed first useful action, including the material refusal or recovery case.
8. Give the reviewer the [delivery receipt](../project/delivery.md): verified access, candidate identity, checked journey, limits, owner and expiry.

Build once per effective build configuration. Keep runtime settings separate from build inputs. If an origin or setting is embedded into the artifact, changed bytes require their own verification.

Use complete journeys. A file workflow can require upload, authorized retrieval and privacy checks. A job can require acceptance, progress, result and cancellation. An email action can require authenticated submission and the intended recipient's receipt. Use the exact action, process and authorized recipient; a generic probe does not establish another feature's path.

When a stage fails, retain a reachable diagnostic environment when appropriate and mark the journey incomplete. Use [recovery](recovery.md) to choose the next action. Use [retirement](retirement.md) for expiry and cleanup even if the preview never reached acceptance.
