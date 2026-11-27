# Prove data access and recovery through the application

Trace the consuming client, schema, migration and required operations before selecting a database version or custom image. A copied version preference does not establish an application requirement.

Check the intended environment's endpoint, identity, data scope, protocol and required extensions or capabilities. Exercise a representative read and write within the authorized scope, then verify the application sees the result. Include transaction, concurrency or refusal behavior when the change depends on it.

Identify the owner of migrations and the compatibility of old and new consumers. Distinguish online-compatible changes from maintenance that needs writers to stop. Record how partial migrations are detected and recovered. An older application starting does not prove the data can be downgraded.

For retained data, establish the recovery objective and the available backup, log or snapshot chain. Restore to a separate destination when authorized, then check meaningful application reads. A backup schedule, successful upload or restore process alone leaves the consumed data unverified.

Record database state, active writers, retention and resource ownership before retrying or deleting. Borrowed platform storage and an application's disposable test data have different lifecycles. Keep unknown state explicit when access or inspection fails.
