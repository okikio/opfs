# Independent Tink ciphertext fixtures

These 14 fixtures were generated on 5 November 2026 by the official `github.com/tink-crypto/tink-go/v2` module at
**v2.9.0**, using **Go 1.27.2** on darwin/arm64. No OPFS code was used to produce ciphertext or plaintext expectations.
The generator first encrypted through Tink and then decrypted through Tink to confirm its own output. The TypeScript
tests consume this fixed JSON; they do not invoke Go, download a module or compute expected ciphertext from the
candidate.

Producer commit:
[`991d2dc20e84ca1159209bab9212c960eb893a2f`](https://github.com/tink-crypto/tink-go/commit/991d2dc20e84ca1159209bab9212c960eb893a2f).
The independent framing implementation is
[`streamingaead/subtle/aes_gcm_hkdf.go`](https://github.com/tink-crypto/tink-go/blob/991d2dc20e84ca1159209bab9212c960eb893a2f/streamingaead/subtle/aes_gcm_hkdf.go).
The Tink module is Apache-2.0 licensed. No implementation source was copied into OPFS; generated outputs and a small
OPFS-authored invocation program are retained here for reproducibility.

`vectors.json` SHA-256: `4d4ffba08632546a835310afeced237ae7b782b43dfa3373f5ebe82780901fa4`. Producer module checksum:
`github.com/tink-crypto/tink-go/v2 v2.9.0 h1:uvjgS1IYDB4zhDK0Zow8ZFB73IjzMAoSqW0JkFnvkrc=`. `go.mod.txt` and
`go.sum.txt` pin the validation-only graph and checksums. They are inert text fixtures, not an OPFS dependency or an
executable setup step. Production TypeScript uses WebCrypto and imports no Go or Tink runtime.

Each vector names its AES key size, ciphertext segment size and plaintext length. The profile is HKDF-SHA256, raw
ciphertext, 16-byte GCM tags and first-segment offset zero. AES-128 uses 64-byte segments, with lengths 0, 1, 24, 25,
72, 73 and 173. AES-256 uses 128-byte segments, with lengths 0, 1, 72, 73, 184, 185 and 409. This includes empty input,
exact first/full-final boundaries and multiple non-final segments. Public sequential test keys and patterned plaintext
are deliberately not production secrets or entropy recommendations.

The encryption test supplies the retained ciphertext header's salt and nonce-prefix as test randomness, then compares
every produced byte with the independent Tink output. The decryption test authenticates those bytes and compares with
the retained plaintext. That establishes interoperability without making a self-roundtrip its own oracle. Broader
malformed-input and ownership tests are in `tests/tink.test.ts`. These fixtures do not certify unsupported hash
profiles, keyset/output-prefix parsing, nonzero offsets, every runtime or cryptographic security.

For deliberate regeneration, use a disposable directory outside the package. Copy `generator.go.txt` as `main.go`,
`go.mod.txt` as `go.mod` and `go.sum.txt` as `go.sum`. With Go 1.27.2, run `go mod download` and then `go run .` into a
new JSON file. Isolate `GOMODCACHE` and `GOCACHE` if needed. Review the module checksums and the resulting diff before
replacing this fixture. Tink chooses fresh randomness, so regeneration produces new ciphertext and a new digest; it is
not expected to reproduce the old file byte-for-byte. Update the provenance and rerun interoperability tests together.
