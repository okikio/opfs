# Verify the intended email action

Trace the actual application action, its sender configuration, the client transport and the recipient. Confirm that the test message and destination are authorized before sending; a service card does not supply that authority.

Distinguish transport connection, authentication, provider acceptance, delivery events and recipient receipt. The required evidence depends on the feature. An invitation also needs its persisted identity, link origin, expiry, membership effect and applicable refusal behavior.

Check the current provider and runtime contract for supported protocols, ports, sender verification, callbacks and limits. A provider dashboard key or a successful generic diagnostic does not prove that the application's invitation route uses it correctly.

Use the actual intended account type. A group mailbox and an individual authentication identity can have different roles. Preserve real accounts and existing access; do not reset another person's password or bypass consent to make a test convenient.

Retain non-secret request identifiers, observed errors and partial state for safe retry. Define how duplicate submission, delayed callbacks and repeated user actions are handled. Record recipient and payload evidence according to the project's privacy policy.
