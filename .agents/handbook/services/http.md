# Check the public route and each runtime role

Trace a request from the user's origin through routing, authentication, application handling and required downstream consumers. Check the actual deployed artifact and settings, not only the source build.

Record name resolution, certificate behavior, public response, origin response, required containers or processes, private connections and worker startup separately. A healthy API does not establish that a background consumer is running or that a migration completed.

Exercise the intended operation with representative input. Inspect status, body, headers and output type as relevant. An HTTP success that returns a sign-in page does not prove that a public asset or API result loaded correctly.

Bind health checks to the behavior they promise. Liveness, readiness, dependency access and user acceptance can have different meanings. Preserve bounded diagnostics and the earliest failing stage instead of replacing the whole environment after a single generic health failure.

Verify startup, termination signals, active work, cleanup, writable paths and resource limits for each process role. Shared images can have different commands, identities and exposure. Keep those contracts explicit in the [ownership record](../project/ownership.md).
