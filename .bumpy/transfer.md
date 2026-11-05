---
"@okikio/opfs": minor
---

### Resume acknowledged uploads through explicit checkpoints

New optional `gcs`, `driver/gcs` and `adapter/gcs` subpaths implement Google Cloud Storage JSON operations and
generation-aware filesystem access. `tus` implements core known-length tus 1.0 uploads. `transfer` reconciles a durable
checkpoint with provider state, copies bounded source chunks and reports completion only after final publication is
confirmed. The application owns authentication, exclusive session use and atomic checkpoint persistence.

See the GCS and transfer guides for complete examples, server requirements and recovery limits. Encrypted-write restart
and durable S3 multipart/Azure block recovery are not added by these exports. GCS emulator tests do not establish
production credentials, IAM, CORS or durability behavior.
