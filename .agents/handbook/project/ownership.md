# Map components, state and resources

Record each process role separately, even when several roles share an artifact. Show the real caller and who owns the data or resource after each operation.

| Component or operation | Maintained owner | Inputs and outputs | Runtime and placement | State or resource owner | Consumers and cleanup |
| --- | --- | --- | --- | --- | --- |
| | | | | | |

For a live resource, record whether it is acquired, borrowed or transferred. Distinguish cancellation from disposal, progress from terminal results, and transient state from persisted recovery state.

For deployed resources, distinguish shared platform, application instance, application behavior and deployment-operation ownership. Mark retained data and resources that the task must not delete. For a reusable package, record public exports and supported consumer hosts instead of inventing deployment fields.

Trace the normal action and its important error, retry, concurrent and cleanup paths. Use the map to find affected consumers when a contract changes.
