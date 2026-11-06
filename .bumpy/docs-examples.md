---
"@okikio/opfs": patch
---

Follow complete examples for a custom record backend, canceled archive previews and persisted upload continuation.

The guides now show the backend before its driver and adapter, pass cancellation through each preview operation, and
inject Fetch into remote-source examples. The transfer guide includes separate start and continue functions, explains
who owns atomic checkpoint storage, and retains a newly created session when the initial save fails.

The documentation task runs eleven exact guide examples against bounded local fixtures. A separate strict check checks
the same extracted code, so example types and behavior are both maintained. Local continuation checks use separate
invocations in one process; they do not prove crash durability or live service behavior.
