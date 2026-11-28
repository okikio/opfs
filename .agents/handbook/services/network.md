# Verify connectivity from the intended workload

Identify the source process, destination, route, protocol and identity required by the operation. Test from the actual consuming environment when making a runtime claim.

Separate management access, application access and temporary deployment access. Their credentials, permissions and network locations can differ. A successful operator connection does not prove the application's path.

Check endpoint resolution, route selection, transport security, required ports, proxy behavior and destination authorization as applicable. Retain enough metadata to explain which path was used without exposing credentials or sensitive payloads.

When state is still converging, use the platform's bounded observation mechanism and phase-specific diagnostics. Avoid treating an asynchronous route as absent simply because another component is already healthy. Conversely, a configured route does not prove the intended request succeeds.

Record the owner of network resources and the cleanup of temporary identities or connections. Recheck the contract after relevant topology, identity, endpoint or policy changes. Keep connectivity evidence separate from application semantics and durable completion.
