# Retire temporary resources by ownership

Use this procedure when a preview or experiment expires, is replaced or no longer serves its agreed purpose. Confirm the original receipt and ownership before deletion.

1. Identify the exact environment, resources, identities and retention requirements.
2. Separate owned temporary resources from production, borrowed platform resources and intentionally retained data.
3. Stop background work and revoke temporary external access through its supported owner.
4. Export only data that the retention contract requires, using an approved destination.
5. Remove the owned application resources, routes, identities and disposable data through the owning tool.
6. Check retained object versions, volumes, addresses, credentials and scheduled work.
7. Record any remaining resource, its owner, reason and next action.

A name prefix alone is insufficient evidence of ownership. If identity is ambiguous, inspect the original record before deletion. Automated expiry must use the same ownership and retention rules as manual cleanup.

Verify cleanup independently from reachability. An application that no longer responds can still leave chargeable storage, active jobs or credentials. Mark incomplete cleanup explicitly in the [delivery record](../project/delivery.md).
