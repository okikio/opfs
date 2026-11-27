# Record the candidate and its delivery

Connect source, build, publication and runtime evidence without treating them as one identity. Omit deployment fields for work that delivers only a package, executable or document.

| Stage | Identity and evidence |
| --- | --- |
| Source | Repository, branch, revision, locks and relevant local changes. |
| Build | Effective inputs, toolchain, command and artifact contents. |
| Artifact | Immutable version or digest, platform and consumer checks. |
| Publication | Destination and evidence that the intended consumer can obtain the exact artifact. |
| Preview, if required | Environment, access, configuration, checked journey, owner and expiry. |
| Production, if authorized | Selected candidate, target, operation/plan, migration class and deployed identity. |
| Acceptance | Actual user action, operating signals and remaining limits. |
| Recovery | Prior/current identities, retained data, supported action and owner. |
| Retirement | Removed resources, retained resources and incomplete cleanup. |

Keep timestamps for the meaningful transitions in one time zone. Distinguish active work, queueing and external waiting when evaluating delivery speed.

An artifact rebuilt with changed effective inputs needs its own identity and evidence. A completed publication does not prove deployment; a completed deployment does not prove acceptance. Link the [acceptance action](acceptance.md) that closes the promised outcome.
