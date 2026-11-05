---
"@okikio/opfs": minor
---

### Authenticate covering segments before returning encrypted previews

The optional `crypto/tink` subpath implements one raw AES-GCM-HKDF SHA256 streaming payload profile through injected
WebCrypto. Opening authenticates the final segment before trusting plaintext length; selected reads authenticate all
covering segments before returning bytes. Explicit whole-envelope verification has its own admission budget.

The application owns keys, associated data, exact profile parameters and ciphertext identity. This profile composes with
archive byte sources but does not add password ZIP support, encrypted-write restart or a security-audit claim. See the
encryption guide and independently produced Tink fixtures for the supported boundaries and interoperability evidence.
