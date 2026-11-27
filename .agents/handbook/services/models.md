# Verify model calls and agent execution separately

A model endpoint, an application agent and a coding runner expose different contracts. Identify which consumer the task changes before choosing a provider, adapter or execution environment.

For a model call, record the actual model identity, endpoint, client version, protocol, supported inputs, output handling, tool behavior and limits. Inspect the outgoing request when an SDK option affects correctness or cost. A successful finite probe does not establish that the application's streaming or tool loop uses the same contract.

Measure useful completed tasks when comparing choices. Preserve quality, errors, retries, latency and actual usage. A lower advertised token price alone does not establish lower cost per successful outcome. Verify current applicable rates before calculating currency cost.

For a runner, trace job admission, claims, allowed tools, credentials, resource limits, progress, result ownership, cancellation, stale-result rejection, artifacts and cleanup. A process launcher supplies only the behavior it implements. Logs and progress events do not automatically become authoritative terminal state.

Use the existing execution model unless a demonstrated requirement needs another layer. Test recovery and isolation claims through their actual consumer. Bound paid operations and external effects within the task's established authorization and data policy.
