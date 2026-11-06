# Preview selected content with explicit costs and trust

This proposed contract is for application developers building archive browsers and extension authors supplying readers. It does not add a preview API today. Applications render text, images and thumbnails; OPFS supplies bounded metadata and bytes, cancellation, and evidence about those bytes. No content executes during inspection.

A user opens a remote ZIP, sees its entries, selects a photo, and requests a small preview. The application first obtains a stable source revision, selects a format definition and asks for an operation plan. The plan describes access, required keys/codecs, authentication units, work estimates or unknowns, and budgets. The user can accept the cost, increase a limit, supply a key, or stop. Closing the preview cancels its outstanding work and releases owned resources. A changed object requires reopening a new snapshot; it must not mix old directory offsets with new contents.

## Operations are independent capabilities

| Operation | Result | What it does not establish |
| --- | --- | --- |
| Identify | Candidate format/profile and evidence | Valid structure, safe contents or a supported decoder |
| List / metadata | Stable entry identities and selected fields | Readable payloads, safe paths or authenticated names |
| Prefix | Up to a requested number of decoded bytes | Cheap access, full-member integrity or complete content |
| Range | A decoded interval of one member | Independent seeking unless the format supports it |
| Extract | Selected complete members to an explicit sink | Whole-archive verification or transactional restore |
| Verify | Mechanism, scope, outcome and bytes examined | Trust in an unsigned publisher or unchecked members |
| Restore | An admitted projection into a destination | Atomic cross-provider publication |

These form a capability vector, not a universal ladder. An encrypted-header archive may be identifiable but locked for listing; an encoding or signature record is not a container. Disk-image blocks do not imply support for the inner filesystem. The [136-record routes](preview-routing.json) preserve these distinctions. Exact profile, container version, compression method, encryption construction and source capabilities must all match.

Preserve duplicate names, raw member identity and original metadata. A tree view applies an explicit name/link policy; it must not silently overwrite duplicates, follow symlinks, read host files or fetch referenced URLs. Caller-supplied resolvers authorize specific external bases, volumes, manifests and parent chains. Limit resolution depth and cycles.

## Access determines work

| Profile or route | Likely work for selected bytes | Admission limit |
| --- | --- | --- |
| ZIP with revision-bound ranges | Read tail/directory, locate a member; deflated content normally decodes from the member start | Index size, requests and decoded bytes; ZIP64 and each compression method are separate support claims |
| Uncompressed TAR | Sequential header scan; a range-capable implementation can skip payload extents | Header/extension parsing and member count; a sequential implementation still reads preceding bytes |
| Compressed TAR / ordinary gzip | Replay decompression from an earlier supported boundary, often the start | Compressed and expanded work; stopping early is not random seeking |
| Solid 7z / RAR | Replay dictionary state from the solid-group boundary | Dictionary memory, replay and exact algorithm version; encrypted headers can block listing |
| Seekable Zstandard / indexed frames | Read an index and selected independent frames | Exact indexed profile, index validation and frame-level work |
| Whole-member/message MAC or AEAD | Verify the protected unit before releasing authenticated plaintext | All required ciphertext and possibly explicit staging even for a short preview |
| Independently authenticated chunks | Read header/key setup and complete covering chunks | Chunk integrity is not full-file completeness; exact final-chunk rules apply |
| Vault / backup repository | Resolve namespace/index/chunk dependencies and verify their relationships | Exact layout versions, key derivation, references and snapshot identity |

Sources and qualifications are in [preview research](preview-research.md). In particular, WinZip AES does not gain an authenticated early prefix from CTR seeking alone. age permits authenticated chunk seeking with its final-chunk rules; Tink streaming AEAD permits segment access with its own framing and derivation rules. Stateful authenticated streams such as secretstream do not thereby permit independent seeking. Do not collapse all three into one streaming-encryption flag.

Evaluate age as an interoperable encrypted-file/export profile and Tink AES-GCM-HKDF streaming as a segmented payload-source candidate. Neither is selected as a dependency or implemented by this plan. Preserve their distinct key/recipient, framing and seeking contracts; do not invent a new wire format by blending them. A vault's filename encryption and namespace semantics need a separate implementation.

## Report evidence, not a trusted boolean

Every result must distinguish metadata visibility from metadata authentication, confidentiality from integrity, and selected bytes from completeness. Record the mechanism and scope: parsed-only, checksum pending/passed, member MAC verified, authenticated chunk, full envelope verified, or signature verified under a caller-owned trust policy. A checksum detects some corruption; it is not sender authentication. A verified chunk cannot label unchecked chunks verified. Legacy unauthenticated formats remain explicitly unauthenticated.

The default encrypted-preview policy releases no unauthenticated decrypted bytes. If the profile authenticates a whole member/message, authenticate that entire unit first. Use an explicit bounded ciphertext or plaintext staging policy where required, or refuse the operation with the required cost. Never present speculative plaintext as a successful trusted preview. On verification failure, discard staged plaintext and close resources. Plain unencrypted prefixes can be returned with checksum-pending evidence when policy permits; the consumer sees that status before rendering.

Signatures require a separately supplied trust policy and exact signed scope. Unlocking a header is not a password-validity oracle with unlimited retries. KDF parameters, key attempts and decoder memory require admission limits before expensive work. Secrets must not enter logs, filenames, benchmark artifacts or resumable checkpoint serialization.

## One budget follows the whole operation

A request for 4 KiB returned bytes is not a limit of 4 KiB fetched or decoded. Track separate maximums for returned bytes, source bytes, requests, parsed index bytes, decoded bytes, decrypted/authenticated bytes, retained memory, staging storage, entries, decoder/KDF memory, replay, elapsed work and nesting/reference depth. Charge nested readers and composed transforms to the same operation ledger. Budget units, accounting boundaries and oversize source-chunk handling belong in the contract; do not count only the final sink.

Planning is pure and does no I/O. It can report unknown cost and the prerequisites for refining an estimate. Execution performs bounded discovery and updates actual counters. Restrict synchronous codec input and memory explicitly, but do not claim those restrictions enforce a hard time deadline. Declare deadline enforcement cooperative or unavailable on that route; refuse a hard deadline request unless a caller-approved terminable worker or equivalent owner can enforce it. An AbortSignal alone cannot preempt synchronous work. A limit failure reports what was exhausted and how to retry. It never silently downloads everything, spools without a quota, runs a host tool or fetches a codec.

Keep source revisions stable across indexes, payloads and external references. Validate range responses and reject changed versions. An explicit bounded snapshot is an alternative when the backend cannot bind reads. A caller may explicitly accept an assertion that the source stays unchanged, but report that weaker assumption and mutation risk separately; it is not provider-verified snapshot consistency. Resume checkpoints bind source revision, profile/version, index identity, transform parameters and key-context identity without persisting raw keys. Restart at a valid authenticated/decoder boundary; do not serialize arbitrary decoder internals or reuse nonces under changed input.

The operation owns its reader locks, decoder instances, requests and staging objects. Early iterator return, error, abort and success all retire them. Borrowed sources and keys remain borrowed. Prefix inspection should replay a bounded prefix through one owned reader; an abandoned tee branch can retain bytes despite a short sniff limit.

## Evidence before a profile becomes supported

Use independent fixtures and interoperability readers/writers for each claimed profile, not only self-roundtrips. Test malformed offsets and sizes, truncation, duplicate entries, path/link projections, wrong keys, tampering, encrypted headers, missing volumes, dictionary/KDF limits, source changes, all relevant chunk boundaries, slow consumers and oversized chunks. Assert that a 4 KiB preview does not extract unrelated entries, and that whole-unit authentication either completes within budget or refuses before plaintext release.

Measure identify, listing, first/late member prefix, selected range, verification, nested access, cancellation and restart separately. Include indexed/sequential sources, solid groups and cold/warm indexes. Publish actual fetched/decoded/decrypted/returned bytes, staging, peak/retained memory and latency distributions. No performance results have been produced by this planning update. [ENGINEERING.md](ENGINEERING.md) defines the implementation and benchmark gates; [EXTENSIONS.md](EXTENSIONS.md) makes the same obligations available to external authors.
