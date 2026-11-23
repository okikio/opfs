---
npm/@okikio/opfs: patch
---

### Stop provider control responses that make no bounded progress

S3, Azure, GCS and other clients that use the shared control-text reader now refuse a response after 65,536 read
attempts or more than 16 consecutive empty chunks. Read attempts include empty chunks, failed reads and the final EOF
check. A nonempty chunk resets the consecutive-empty allowance. The existing 8 MiB control-text ceiling still applies.
These are implementation safety limits for XML, JSON and error text, separate from streamed file payloads.

Previously a custom Fetch response could keep producing empty chunks without reaching the byte ceiling. That could
consume unbounded read work and keep timer-based cancellation from running. The reader now reports a RangeError, awaits
cancellation of its still-readable source, and releases its reader lock. If source cancellation or lock release also
fails, the operation retains those independent failures alongside the original budget failure.

An otherwise valid control response can be refused when it is excessively fragmented. For example, 65,535 one-byte
chunks plus EOF fit the read allowance; 65,536 one-byte chunks leave no attempt for EOF and are refused. Header-only
acknowledgements continue to cancel unused bodies without reading them. Successful file GET streams and raw request
responses retain their existing caller-owned lifetime. A custom transport must still settle its cancellation hook; these
limits do not impose a separate cleanup timeout or authorize replaying a mutation.
