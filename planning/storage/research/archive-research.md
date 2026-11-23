# Archive and encryption formats for OPFS

Reviewed 5 November 2026 UTC.

This review contains **136 format, profile, convention, and host-feature records**, plus **14 implementation candidates**. These counts are not provider counts. The accompanying workbook and JSON distinguish the specification, implementation evidence, and proposed OPFS integration.

Archives and encryption belong in the storage research because they can change member listing, byte-range access, update cost, metadata fidelity, recovery, and key handling. They can be stored as ordinary bytes without understanding them. Semantic support begins when OPFS promises to list an archive, decrypt a file, browse a vault, validate a preservation package, or restore a snapshot.

The existing 895-entry storage catalog is retained unchanged. The crosswalk links this focused review to its existing records and identifies additional profiles that could be incorporated in a deliberate catalog revision. No OPFS implementation, branch merge, or new support claim is made by this research.

## The categories need different integration contracts

| Category | Examples | What OPFS would need to understand |
| --- | --- | --- |
| Archive container | ZIP, tar/PAX, 7z, RAR, cpio, CAB, WIM | Members, names, metadata, compression methods, split volumes, and extraction |
| Compression stream or framing | gzip, zlib, Zstandard, XZ, LZ4, Brotli, Snappy framed | Encoding, framing, dictionaries, checksums, restart points, and output limits |
| Encrypted file envelope | age, OpenPGP, CMS, AES Crypt | Key recipients, password derivation, authenticated content, framing, and complete-file validation |
| Archive encryption profile | WinZip AES, PKWARE strong encryption, 7z encryption, RAR encryption | The exact archive method, password/key encoding, visible metadata, and compatible readers |
| Encrypted vault | Cryptomator, rclone crypt, gocryptfs, CryFS, securefs | A persistent encrypted namespace, chunk mapping, configuration, and coordinated updates |
| Filesystem or volume encryption | fscrypt, EFS, LUKS, VeraCrypt, BitLocker, APFS/FileVault | Host key management, block/filesystem interpretation, and mounted access |
| Backup repository | restic, Borg, Kopia, Duplicati, Duplicity, Tarsnap | Snapshots, chunk packs, indexes, key metadata, locks, retention, and recovery |
| Preservation package | BagIt, OCFL, WARC/WACZ, E-ARK | Manifests, fixity, object versions, capture records, and validation rules |
| Signatures and recovery | ASiC, evidence records, Minisign, PAR2 | Authenticity, archival evidence, or repair data; these do not all encrypt contents |
| Key/credential container or encoding | PKCS#8, PKCS#12, JWK, COSE_Key, KDBX, PEM/DER | Key import/export or a specialized document model; not a generic byte-store replacement |

These are architectural categories. The source links in each inventory record establish the individual format claims. A single format can combine several functions, but OPFS should still expose those capabilities separately.

## Archive support is more than recognizing an extension

**ZIP is a family of profiles.** Basic ZIP, ZIP64 size/offset extensions, ZIPX compression choices, split archives, password methods, and filename encodings are different compatibility questions. The central directory supports member lookup. Data descriptors permit writing entries when their final sizes are not known in advance, so a ZIP writer can stream even when a particular reader requires seeking. ZIP64 does not specify encryption, and a `.zipx` extension does not identify one universally supported codec. See [PKWARE APPNOTE](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT) and [WinZip's ZIPX description](https://kb.winzip.com/en/130326).

For an OPFS archive view, there are two separate random-access questions: can the reader locate a member without scanning every earlier member, and can it jump into that member's uncompressed contents? An archive directory can answer the first while a compressed member still requires decoding from a restart point. This distinction follows from the container directory and codec state, and should appear in the capability model.

**TAR needs explicit metadata profiles.** POSIX ustar, pax extended headers, GNU extensions, and sparse-file layouts cannot be collapsed into a single promise that every reader preserves everything. PAX extends the older fixed-field representation, while implementation-specific fields may carry additional metadata. A tar reader that returns file contents can still lose link targets, sparse extents, ownership, timestamps, ACLs, or extended attributes. The destination must also be able to represent those properties. See the [GNU tar format comparison](https://www.gnu.org/software/tar/manual/html_section/Portability.html) and [GNU sparse PAX representation](https://www.gnu.org/software/tar/manual/html_node/PAX-1.html).

**7z and RAR add solid-compression concerns.** Solid compression shares compression state across files. It can improve compression of related files, but accessing a later member can require processing earlier data in the solid block. A member-selection API therefore does not imply cheap remote range reads. RAR also distinguishes container format from compression-algorithm versions, and documents multivolume and recovery-record flags. See the [7z format overview](https://www.7-zip.org/7z.html) and [RAR5 technical note](https://www.rarlab.com/technote.htm).

**The enterprise and legacy set is materially larger.** The inventory includes cpio variants, GNU/BSD ar and thin archives, CAB, WIM/SWM/ESD, XAR, ZPAQ, DAR, ISO 9660/UDF, and legacy archive families. Each has a reason to remain visible in a compatibility catalog. Examples include software packages, deployment images, incremental backups, optical-media collections, and older customer archives. A thin ar archive can refer to external files, so copying its bytes does not necessarily produce a self-contained backup. WIM image resources, solid ESD variants, and disk-image filesystems also need more than a generic ZIP interface. Individual primary sources and constraints are retained in the complete inventory.

**Recovery is separate from detection.** A checksum can show that bytes changed. PAR2 supplies redundant data that can repair some missing or damaged data when sufficient recovery blocks remain. Split archives merely divide content across files; splitting alone does not provide redundancy. ZPAQ and DAR also introduce backup-oriented concerns such as journaling or catalogs that should not be reduced to a codec label. See the [PAR2 specification](https://parchive.github.io/doc/Parity%20Volume%20Set%20Specification%20v2.0.html), [ZPAQ documentation](https://www.mattmahoney.net/dc/zpaqdoc.html), and [DAR documentation](https://github.com/Edrusb/DAR/blob/master/man/dar.1).

Self-extracting archives deserve an explicit policy: parsing the embedded archive does not require running the executable wrapper. Similarly, reading an application package as ZIP or tar does not establish that its package-specific manifest, signature, or install behavior has been validated.

## Compression belongs below the archive view

The review separates raw DEFLATE from zlib and gzip framing; LZMA-Alone from XZ; raw LZO from lzop; and Snappy blocks from framed streams. Supporting the compression algorithm alone does not establish that a decoder accepts the wrapper, metadata, checksum, or dictionary conventions used by a file. The normative framing distinctions are visible in [RFC 1950](https://www.rfc-editor.org/rfc/rfc1950.html), [RFC 1951](https://www.rfc-editor.org/rfc/rfc1951.html), and [RFC 1952](https://www.rfc-editor.org/rfc/rfc1952.html).

| Compression group | Storage implication |
| --- | --- |
| gzip, zlib, raw DEFLATE | Useful portable stream transforms. Treat the three wire representations as separate capabilities. |
| Zstandard | Useful framed compression with dictionary and memory requirements that need explicit handling. |
| Seekable Zstandard | Adds independently compressed frames and an index for reaching subranges. Ordinary Zstandard support does not imply this index is used. |
| XZ/LZMA2 | Block/index and filter-chain handling affect seeking and memory. A whole-stream decoder is not proof of efficient indexed reads. |
| LZ4 and Snappy framing | Fast block-oriented families; the frame/block conventions still determine interoperability and integrity checking. |
| Brotli | A byte-stream codec, with no archive directory or filesystem metadata model. |
| bzip2, lzip, Unix compress, LZO/lzop | Relevant compatibility transforms, with separate framing and recovery properties. |
| BGZF | A blocked gzip convention used in scientific file access; access also depends on its indexing conventions. |
| LZFSE | Apple compression family relevant to Apple archive tooling; not itself a multi-file archive. |

The Zstandard seekable format is a good example of the informal specifications the original storage research was intended to surface: independently compressed frames plus a seek table make a concrete storage capability possible. It is a project specification rather than the base RFC format. Also, RFC 9659 updates Zstandard's window-size requirement specifically for HTTP contexts; that should not silently become a universal restriction on every local `.zst` file. See the [seekable-format specification](https://github.com/facebook/zstd/blob/dev/contrib/seekable_format/zstd_seekable_compression_format.md) and [RFC 9659](https://www.rfc-editor.org/rfc/rfc9659.html).

The earlier catalog's reference-only treatment of raw payload codecs is compatible with this review: storing a `.gz` file as opaque bytes requires no codec. Adding transparent compression, archive extraction, or indexed decompression gives the codec an opt-in operational role. It still does not become a storage provider.

## Encryption must name the envelope and its profile

An algorithm name is insufficient to describe an encrypted file. Interoperability also requires the framing, nonce generation, key derivation, key wrapping, recipient representation, metadata authentication, and completion rules. A file described only as “AES-256 encrypted” leaves those questions unanswered.

**age** is a focused file-encryption envelope with recipient stanzas and a chunked authenticated payload. Its specification permits chunk-based seeking, requires final-chunk validation for seeking relative to the end, and prohibits modifying an existing payload without fresh-nonce re-encryption. It does not provide a directory of named files by itself. A tar archive can be placed inside an age envelope, but the tar layout still controls member discovery. Recipient support is another compatibility dimension, including passwords, public keys, post-quantum/hybrid profiles, and plugins. See the [age format specification](https://age-encryption.org/v1).

**OpenPGP** combines encrypted packets, literal data, compression, signatures, and key formats. The current base specification is RFC 9580, which supersedes RFC 4880. Current research also found RFC 9980, *Post-Quantum Cryptography in OpenPGP*, published as Proposed Standard and extending RFC 9580. A published specification is not evidence that all installed GnuPG, OpenPGP.js, Sequoia, or other readers support its newest packets and algorithms. Reader/writer profiles must be named and exercised against actual peers. See [RFC 9580](https://www.rfc-editor.org/rfc/rfc9580.html) and [RFC 9980](https://www.rfc-editor.org/info/rfc9980/).

**CMS** is relevant to enterprise certificate workflows. EnvelopedData and AuthEnvelopedData are distinct structures, and signing, encryption, and recipient mechanisms are separate choices. JWE and COSE are also real standardized encrypted-object representations. Neither automatically supplies an archive directory or a resumable, seekable, large-file storage layout. They are useful when a consuming protocol already requires the format. See [CMS, RFC 5652](https://www.rfc-editor.org/rfc/rfc5652.html), [AuthEnvelopedData, RFC 5083](https://www.rfc-editor.org/rfc/rfc5083.html), [JWE, RFC 7516](https://www.rfc-editor.org/rfc/rfc7516.html), and [COSE structures, RFC 9052](https://www.rfc-editor.org/rfc/rfc9052.html).

**Streaming encryption constructions need their own distinction.** Tink Streaming AEAD supports authenticated partial decryption, but changing existing ciphertext requires re-encrypting the stream. Libsodium secretstream is an ordered, stateful message stream with authentication and rekeying. A secretstream API still needs an application-level file framing and key-management contract. These are different integration choices, not interchangeable `.encrypted` formats. See [Tink Streaming AEAD](https://developers.google.com/tink/streaming-aead) and [libsodium encrypted streams](https://doc.libsodium.org/secret-key_cryptography/secretstream).

The inventory also retains AWS Encryption SDK message formats, the separate S3 Encryption Client format, AES Crypt, the scrypt file format, OpenSSL `enc` compatibility, signature formats, and key containers. The shared use of a cipher or KDF does not make those ciphertexts interoperable. Server-side provider encryption controls belong with provider configuration, while client-side envelopes determine the stored ciphertext representation.

## Password-protected archives have incompatible encryption profiles

| Profile | What needs an explicit support decision |
| --- | --- |
| Traditional ZIP encryption / ZipCrypto | Legacy read/import compatibility. It should not be a new secure-export default. |
| WinZip AES AE-1 / AE-2 | Exact method, password handling, CRC/authentication differences, and reader support. Ordinary entry encryption does not hide the archive's names. |
| PKWARE strong encryption | A separate ZIP encryption family with different algorithm/recipient structures. WinZip AES support does not establish support for it. |
| ZIP central-directory encryption | Separate metadata-hiding profile with specific structural requirements. |
| 7z encryption | Content and header-encryption choices, compression methods, and password derivation must all match the reader. |
| RAR5 encryption | Content and archive-header encryption are distinct records; flags and hash/MAC behavior matter. |

The relevant references are [WinZip AES](https://www.winzip.com/en/support/aes-encryption/), [PKWARE APPNOTE](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT), [7z](https://www.7-zip.org/7z.html), and the [RAR5 encryption records](https://www.rarlab.com/technote.htm). The detailed inventory records the narrower claims and limitations for each profile.

Authenticated encryption means a key holder can detect changes within the authenticated scope. It does not by itself identify the sender or prove that the data is the latest version. A CRC is an accidental-corruption check, and encryption alone does not establish authentication. Likewise, authenticated file blocks do not automatically prove that the latest complete directory tree has been returned. Rollback protection needs a freshness mechanism or trusted state; it cannot be inferred from the phrase “AES encryption.”

Complete-file verification is another separate property. For example, rclone crypt documents authenticated chunks without an authenticated final-length field or last-chunk marker. From that framing, a valid prefix ending at a complete chunk cannot be distinguished from a shorter valid file by chunk authentication alone. This is a format-level inference, not an executed attack or runtime test. Workflows requiring completeness should use an independently trusted length, digest, or manifest. See [rclone's file format](https://rclone.org/crypt/#file-formats).

## Vaults change the namespace as well as the bytes

Cryptomator, rclone crypt, gocryptfs, CryFS, securefs, and EncFS belong in the research because they define persistent layouts above another filesystem or object store. A compatible adapter must preserve configuration, encrypted names, sidecars, file headers, and any tree/index state, not merely call a cipher on each uploaded buffer.

Their metadata contracts differ. Cryptomator encrypts names and obfuscates the directory layout while exposing size, timestamp, and count information. Its current security target also documents an accepted filename-swapping risk within a directory. Rclone crypt preserves the directory tree and offers distinct name-encryption, obfuscation, and no-name-encryption modes. See [Cryptomator's security target](https://docs.cryptomator.org/security/security-target/) and [rclone crypt](https://rclone.org/crypt/).

Gocryptfs forward mode provides a mutable plaintext mount over encrypted files. Reverse mode generates a read-only encrypted view of existing plaintext and uses a different deterministic cryptographic construction. Securefs distinguishes a per-file lite layout from a flattened full layout. CryFS stores an encrypted block tree and maintains local state for rollback detection; a new client must establish its initial state. These are operational differences, not branding differences. See [gocryptfs forward mode](https://nuetzlich.net/gocryptfs/forward_mode_crypto/), [reverse mode](https://nuetzlich.net/gocryptfs/reverse_mode_crypto/), [securefs design](https://github.com/netheril96/securefs/blob/master/docs/design.md), and [CryFS design](https://www.cryfs.org/howitworks).

Fresh source review exposed two lifecycle issues worth retaining. EncFS upstream now describes a Rust rewrite, a new V7 profile, and beta status; its legacy-format and V7 guarantees differ. Its README and security document also differ in their broad wording about legacy write coverage, so that detail remains unresolved pending exact source/fixture validation. CryFS upstream separately labels its 2.0 rewrite alpha and points users to a stable line. Its 2.0 reader cannot access older Twofish or Serpent vaults, and filesystem-ID verification state does not synchronize between 1.0 and 2.0. Neither latest default-branch description should be applied indiscriminately to old vaults. See [EncFS upstream](https://github.com/vgough/encfs), [EncFS security notes](https://github.com/vgough/encfs/blob/master/security.md), and [CryFS compatibility](https://github.com/cryfs/cryfs/blob/main/README.md).

Password changes also need a documented meaning. A format may permit rewrapping a stable file/volume key, while another derives the data keys directly from configuration. Rclone explicitly states that changing the configured password does not convert old data; the content must be re-uploaded with the new configuration. “Rotate password” and “re-encrypt stored content” should therefore be different operations unless the selected format defines them as the same.

## Volumes and host encryption need a separate route

LUKS, VeraCrypt, BitLocker, and APFS/FileVault generally belong behind a host filesystem or a specifically selected image reader. Accessing an unlocked filesystem is substantially different from accepting a raw encrypted device image and implementing its partition table, encryption, and inner filesystem. Linux fscrypt and Windows EFS are file-level host features with their own key and metadata contracts. See [Linux fscrypt](https://docs.kernel.org/filesystems/fscrypt.html), [Windows EFS](https://learn.microsoft.com/en-us/windows/win32/fileio/file-encryption), [VeraCrypt volume format](https://veracrypt.io/en/VeraCrypt%20Volume%20Format%20Specification.html), and [BitLocker configuration](https://learn.microsoft.com/en-us/windows/security/operating-system-security/data-protection/bitlocker/configure).

LUKS is an on-disk key/metadata format, while dm-crypt supplies block encryption. Normal length-preserving disk encryption is not authenticated content encryption. Cryptsetup documents separate authenticated configurations using extra integrity metadata and labels those modes experimental. This is why the catalog does not turn every encrypted disk into an AEAD-capable portable file envelope. See the [cryptsetup manual](https://gitlab.com/cryptsetup/cryptsetup/-/blob/main/man/cryptsetup.8.adoc).

Apple disk images add another layer: image type, partition layout, encryption, and inner filesystem must all match. A sparse bundle is a set of files, while other images are single files. Current Apple documentation also identifies ASIF as a modern sparse image type. Store these opaquely by default and make semantic image access an explicit optional capability. See [Apple Disk Utility image types](https://support.apple.com/en-ie/guide/disk-utility/dskutl11888/mac).

## Backup and preservation formats are their own systems

Restic, Borg, Kopia, Duplicacy, Duplicati, Duplicity, and Tarsnap repositories can contain chunks, packs, indexes, snapshots, keys, and recovery state. Reading an individual object from their backing store is not enough to restore a snapshot. Supporting a repository also does not authorize OPFS to run its retention or pruning operations. The inventory identifies the native tooling or documented format route and keeps read-only inspection distinct from repository mutation.

BagIt describes manifests and package fixity. OCFL describes versioned preservation objects. WARC records web captures, while WACZ packages captures and related indexes. RO-Crate, PREMIS, METS, and E-ARK packaging conventions contribute metadata or preservation structure. These can justify import, export, validation, and virtual views, but they do not all supply encryption or a generic mutable filesystem. Primary specification links are recorded per row in the inventory.

CAR v1/v2 is particularly relevant to the earlier Web3 expansion. It packages content-addressed IPLD blocks, with version-specific indexing behavior. CARv2's published specification is marked Draft and its index is optional. Content identifiers provide a way to check block identity; they do not by themselves encrypt data, guarantee that every referenced block is present, or make a remote provider retain it. The JavaScript `@ipld/car` reader explicitly leaves verification of block bytes against CIDs to its caller. See [CARv1](https://ipld.io/specs/transport/car/carv1/), [CARv2](https://ipld.io/specs/transport/car/carv2/), and [the JavaScript implementation](https://github.com/ipld/js-car).

For encrypted content-addressed storage, the design must explicitly decide whether identifiers name plaintext, ciphertext, or a separately authenticated manifest. That is an application-level choice, not a property implied by the word “archive.”

Signed containers and archival evidence deserve a separate row from encrypted containers. ASiC packages data with signature-related material. Evidence-record standards address long-term integrity evidence. Neither should be advertised as content encryption simply because cryptography is involved.

## The implementation choice changes what can be promised

The comparison includes native libraries, JavaScript libraries, Web APIs, Deno packages, and WASM ports. Their capabilities are not inherited automatically from an upstream format or native library.

The most directly useful OPFS finding is in **zip.js**. Its current `ZipReader` documentation says a plain `ReadableStream` is buffered entirely before the central directory can be read. A custom range reader or suitable lazily read Blob avoids that whole-input buffering. The writer separately exposes temporary-stream storage, including OPFS-backed helpers and a worker-only sync-access-handle helper, with disposal after success, failure, or abort. This provides concrete integration seams while also showing why “streaming support” needs to specify which stage streams. See [ZipReader](https://gildas-lormeau.github.io/zip.js/api/classes/ZipReader.html) and [ZipWriter options](https://gildas-lormeau.github.io/zip.js/api/interfaces/ZipWriterConstructorOptions.html).

**Libarchive** is a broad native format engine, but its read and write format sets differ and its architecture does not establish cheap random member access. A WASM wrapper must separately establish the enabled codecs, crypto build, memory behavior, filesystem bridge, and resource cleanup. **7-Zip** similarly has a broader extraction list than creation list, and an older WASM port must be assessed against its embedded version. See [libarchive](https://www.libarchive.org/), [libarchive formats](https://github.com/libarchive/libarchive/wiki/LibarchiveFormats), and [7-Zip](https://www.7-zip.org/).

**JSZip** explicitly excludes encrypted and multivolume ZIPs and documents memory and ZIP64 limitations. **Fflate** is a candidate for compression and streaming ZIP workflows; encrypted-archive coverage was not established. **Web Compression Streams** provide codec streams, not archive-member parsing. The Deno comparison distinguishes current `@std/tar`, historical `@std/archive`, and community compression packages; their names and runtime claims should not be combined. The implementation matrix contains exact inspected documentation/manifests and all unresolved runtime claims.

No dependency in this review was installed or executed as an OPFS integration. Documentation evidence is sufficient to select candidates for a prototype, but it is not a passed compatibility test.

## What I would implement from this research

The following is an architectural recommendation, separate from the source claims above.

1. **Archive operations with explicit capabilities.** Begin with ZIP/ZIP64 and tar/PAX listing, member reads, extraction, and creation. Publish read and write profiles independently, including compression method, encryption profile, split-volume behavior, and metadata support.
2. **Independent codec transforms.** Reuse gzip/zlib/raw DEFLATE where appropriate, then assess Zstandard, XZ, LZ4, Brotli, and compatibility codecs. Keep seekable framing support separately discoverable.
3. **Named encrypted exports.** Assess age as a focused envelope, OpenPGP for established exchange workflows, and WinZip AES when recipients require encrypted ZIP. Do not invent a custom file format around raw Web Crypto calls.
4. **Optional broad compatibility engines.** Use a carefully selected native or WASM route for 7z/RAR/CAB/WIM/XAR and legacy formats. Expose the methods actually compiled and tested, including read-only formats.
5. **Vault and repository modules.** Add these by explicit user need, with format-version fixtures and recovery workflows. Treat host-mounted encryption separately from direct encrypted-image parsing.
6. **Preservation and recovery operations.** Add BagIt/OCFL/WARC/WACZ/CAR views or validators and PAR2-style recovery where they solve a concrete storage workflow.

The core storage contract should keep ordinary bytes usable without loading archive or cryptographic engines. Optional modules should own parsing, codecs, envelopes, namespace translation, and host tools. That supports broad coverage while keeping provider selection meaningful.

## What an implementation must prove

Validation should demonstrate observable outcomes rather than merely checking that a library imported successfully:

- **Interoperability:** fixtures produced by independent tools, including exact codec/encryption versions, passwords and Unicode names, split archives, empty files, and unsupported methods.
- **Access and resources:** byte ranges requested, peak staging/memory behavior, backpressure, cancellation, worker/subprocess disposal, and cleanup after partial failures.
- **File semantics:** duplicate names, path normalization, case collisions, symbolic/hard links, sparse files, extended attributes, and metadata that the destination cannot represent.
- **Integrity and completion:** altered headers/content, wrong keys, truncated streams, missing volumes, invalid indexes, and the difference between member authentication and whole-result completion.
- **Publication:** partial extraction stays distinguishable from a complete result; a replacement archive is only published after finalization succeeds. Per-file safe writes do not make a multi-file restore transactional.

These requirements follow from the formats' contracts. For example, libarchive exposes opt-in path/symlink extraction protections and per-file safe-write behavior, while age requires complete-stream termination checks. Those obligations must be connected to the destination writer rather than left to a caller's assumptions. See [libarchive disk writer](https://man.freebsd.org/cgi/man.cgi?query=archive_write_disk&sektion=3&format=html) and the [age payload specification](https://age-encryption.org/v1).

## Evidence and checkpoint scope

The saved comparison retains primary URLs, status/version notes, parent catalog links, and explicit unknowns. The accompanying validation file records schema, crosswalk, JSON/CSV/workbook consistency, source-preservation, patch, and checkpoint checks. It does not claim crypto implementation testing, archive interoperability testing, browser/Deno runtime validation, or a new OPFS build.

This is a broad decision inventory. It does not claim exhaustive coverage of every proprietary revision, application-specific encrypted database, game asset pack, firmware image, or historical archive variant. Such formats can be added without redefining them as default storage providers.

## Complete focused inventory

The tables below index every reviewed record. The workbook and JSON retain the full comparison fields, profile constraints, and evidence notes.


### Archives and compression

| Format or profile | Role | Integration proposal | Primary evidence |
| --- | --- | --- | --- |
| ZIP | archive-container | Optional container or repository view | [Source 1](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT) · [Source 2](https://github.com/libarchive/libarchive) |
| ZIP64 extensions | archive-container | Optional container or repository view | [Source 1](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT) |
| ZIPX | archive-container | Optional container or repository view | [Source 1](https://kb.winzip.com/en/130326) · [Source 2](https://kb.winzip.com/en/130350) |
| 7z | archive-container | Optional container or repository view | [Source 1](https://www.7-zip.org/7z.html) · [Source 2](https://github.com/ip7z/7zip/blob/main/DOC/7zFormat.txt) |
| RAR5 container | archive-container | Optional container or repository view | [Source 1](https://www.rarlab.com/technote.htm) · [Source 2](https://www.rarlab.com/rar_add.htm) |
| tar / POSIX ustar | archive-container | Optional container or repository view | [Source 1](https://pubs.opengroup.org/onlinepubs/9799919799/utilities/pax.html) · [Source 2](https://www.gnu.org/software/tar/manual/tar.html) |
| POSIX pax extended tar | archive-container | Optional container or repository view | [Source 1](https://pubs.opengroup.org/onlinepubs/9799919799/utilities/pax.html) · [Source 2](https://www.gnu.org/software/tar/manual/tar.html) |
| GNU tar extensions | archive-container | Optional container or repository view | [Source 1](https://www.gnu.org/software/tar/manual/tar.html) |
| Sparse-file archive representations | archive-metadata-profile | Optional package metadata/validation | [Source 1](https://www.gnu.org/software/tar/manual/html_node/PAX-1.html) · [Source 2](https://www.gnu.org/software/tar/manual/tar.html) |
| cpio: binary, odc, newc and crc | archive-container | Optional container or repository view | [Source 1](https://www.gnu.org/s/cpio/manual/cpio.html) · [Source 2](https://kernel.org/doc/html/v6.19/driver-api/early-userspace/buffer-format.html) |
| ar, including GNU/BSD naming and thin archives | archive-container | Optional container or repository view | [Source 1](https://sourceware.org/binutils/docs/binutils/ar.html) · [Source 2](https://sourceware.org/pipermail/binutils/2016-June/093674.html) |
| Microsoft Cabinet (CAB) | archive-container | Optional container or repository view | [Source 1](https://download.microsoft.com/download/4/D/A/4DA14F27-B4EF-4170-A6E6-5B1EF85B1BAA/%5BMS-CAB%5D.pdf) · [Source 2](https://learn.microsoft.com/en-us/windows/win32/msi/cabinet-files) |
| WIM and split WIM (SWM) | archive-container | Optional container or repository view | [Source 1](https://www.wimlib.net/) · [Source 2](https://wimlib.net/apidoc/group__G__writing__and__overwriting__wims.html) |
| Solid WIM / ESD variants | archive-container | Optional container or repository view | [Source 1](https://www.wimlib.net/) · [Source 2](https://www.wimlib.net/man1/wimexport.html) |
| ISO 9660 / ECMA-119 optical filesystem images | filesystem-image | Optional image reader or host mount | [Source 1](https://ecma-international.org/publications-and-standards/standards/ecma-119/) |
| Universal Disk Format (UDF) | filesystem-image | Optional image reader or host mount | [Source 1](https://ecma-international.org/publications-and-standards/technical-reports/ecma-tr-112/) · [Source 2](https://ecma-international.org/publications-and-standards/standards/ecma-167/) |
| ZPAQ streaming and journaling archives | archive-container | Optional container or repository view | [Source 1](https://www.mattmahoney.net/dc/zpaq206.pdf) · [Source 2](https://www.mattmahoney.net/dc/zpaqdoc.html) |
| DAR archive format | archive-container | Optional container or repository view | [Source 1](https://github.com/Edrusb/DAR/blob/master/README) · [Source 2](https://github.com/Edrusb/DAR/blob/master/man/dar.1) |
| PAR2 recovery volumes | recovery-format | Optional recovery operation | [Source 1](https://parchive.github.io/doc/Parity%20Volume%20Set%20Specification%20v2.0.html) · [Source 2](https://docs.duplicati.com/technical-details/understanding-backup) |
| Raw DEFLATE | compression-format | Optional compression transform | [Source 1](https://www.rfc-editor.org/rfc/rfc1951.html) |
| zlib stream | compression-format | Optional compression transform | [Source 1](https://www.rfc-editor.org/rfc/rfc1950.html) |
| gzip members | compression-format | Optional compression transform | [Source 1](https://www.rfc-editor.org/rfc/rfc1952.html) |
| bzip2 stream | compression-format | Optional compression transform | [Source 1](https://sourceware.org/bzip2/manual/manual.html) |
| XZ container | compression-format | Optional compression transform | [Source 1](https://tukaani.org/xz/format.html) · [Source 2](https://tukaani.org/xz/xz-javadoc/org/tukaani/xz/SeekableXZInputStream.html) |
| Legacy .lzma / LZMA-Alone | compression-format | Optional compression transform | [Source 1](https://github.com/tukaani-project/xz/blob/master/doc/lzma-file-format.txt) · [Source 2](https://github.com/ip7z/7zip/blob/main/DOC/lzma.txt) |
| Zstandard frame | compression-format | Optional compression transform | [Source 1](https://www.rfc-editor.org/rfc/rfc8878.html) · [Source 2](https://www.rfc-editor.org/rfc/rfc9659.html) |
| Zstandard seekable format | compression-format | Optional compression transform | [Source 1](https://github.com/facebook/zstd/blob/dev/contrib/seekable_format/zstd_seekable_compression_format.md) |
| LZ4 frame format | compression-format | Optional compression transform | [Source 1](https://github.com/lz4/lz4/blob/dev/doc/lz4_Frame_format.md) |
| Brotli stream | compression-format | Optional compression transform | [Source 1](https://www.rfc-editor.org/rfc/rfc7932.html) |
| Snappy framed stream | compression-format | Optional compression transform | [Source 1](https://github.com/google/snappy/blob/main/framing_format.txt) |
| lzip | compression-format | Optional compression transform | [Source 1](https://www.nongnu.org/lzip/manual/lzip_manual.html) · [Source 2](https://www.nongnu.org/lzip/manual/lziprecover_manual.html) |
| Unix compress (.Z) | compression-format | Optional compression transform | [Source 1](https://github.com/vapier/ncompress/blob/main/compress.1) · [Source 2](https://github.com/vapier/ncompress/blob/main/compress.c) |
| LZO raw block codecs | compression-format | Optional compression transform | [Source 1](https://www.oberhumer.com/opensource/lzo/) |
| lzop file framing | compression-format | Optional compression transform | [Source 1](https://www.lzop.org/lzop_man.php) |
| BGZF blocked gzip | compression-format | Optional compression transform | [Source 1](https://samtools.github.io/hts-specs/SAMv1.pdf) · [Source 2](https://github.com/samtools/htslib/blob/develop/bgzip.1) |
| RAR 1.5–4.x legacy container | archive-container | Optional container or repository view | [Source 1](https://www.rarlab.com/rar_add.htm) · [Source 2](https://github.com/pmachapman/unrar/blob/master/headers.hpp) |
| XAR (eXtensible ARchive) | archive-container | Optional container or repository view | [Source 1](https://github.com/apple-oss-distributions/xar/blob/main/xar/src/xar.1) · [Source 2](https://github.com/apple-oss-distributions/xar/blob/main/xar/lib/archive.c) |
| SEA ARC and related PAK archives | archive-container | Optional container or repository view | [Source 1](https://github.com/MacPaw/XADMaster/blob/master/XADARCParser.m) · [Source 2](https://theunarchiver.com/archives) |
| ARJ | archive-container | Optional container or repository view | [Source 1](https://arj.sourceforge.net/) · [Source 2](https://github.com/MacPaw/XADMaster/blob/master/XADARJParser.m) |
| LHA / LZH and LArc-related methods | archive-container | Optional container or repository view | [Source 1](https://github.com/jca02266/lha/blob/master/header.doc.md) · [Source 2](https://github.com/fragglet/lhasa/blob/master/doc/lha.1) |
| ACE 1.x / 2.0 | archive-container | Optional container or repository view | [Source 1](https://github.com/droe/acefile/blob/master/README.md) · [Source 2](https://apidoc.roe.ch/acefile) |
| StuffIt classic and version 5 | archive-container | Optional container or repository view | [Source 1](https://github.com/MacPaw/XADMaster/blob/master/XADStuffItParser.m) · [Source 2](https://github.com/MacPaw/XADMaster/blob/master/XADStuffIt5Parser.m) |
| StuffIt X | archive-container | Optional container or repository view | [Source 1](https://github.com/MacPaw/XADMaster/blob/master/XADStuffItXParser.m) · [Source 2](https://theunarchiver.com/archives) |
| AppleSingle / AppleDouble / MacMIME | metadata-container | Optional package metadata/validation | [Source 1](https://www.rfc-editor.org/rfc/rfc1740.html) · [Source 2](https://www.rfc-editor.org/info/rfc1740/) |
| MacBinary I / II / III | archive-container | Optional container or repository view | [Source 1](https://github.com/MacPaw/XADMaster/blob/master/XADMacBinaryParser.m) |
| BinHex 4.0 (.hqx) | archive-container | Optional container or repository view | [Source 1](https://www.rfc-editor.org/rfc/rfc1741.html) |
| Raw disk image | disk-image-format | Optional image reader or host mount | [Source 1](https://www.qemu.org/docs/master/system/images) |
| QCOW2 | disk-image-format | Optional image reader or host mount | [Source 1](https://www.qemu.org/docs/master/interop/qcow2.html) · [Source 2](https://qemu-project.gitlab.io/qemu/tools/qemu-img) |
| VHD (Virtual Hard Disk) | disk-image-format | Optional image reader or host mount | [Source 1](https://www.microsoft.com/en-us/download/details.aspx?id=23850) · [Source 2](https://github.com/qemu/qemu/blob/master/block/vpc.c) |
| VHDX (Virtual Hard Disk v2) | disk-image-format | Optional image reader or host mount | [Source 1](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-vhdx/83e061f8-f6e2-4de1-91bd-5d518a43d477) · [Source 2](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-vhdx/83f6b700-6216-40f0-aa99-9fcb421206e2) |
| VMDK image family | disk-image-format | Optional image reader or host mount | [Source 1](https://www.qemu.org/docs/master/system/images) · [Source 2](https://qemu-project.gitlab.io/qemu/tools/qemu-img) |
| Apple DMG / UDIF image family | disk-image-format | Optional image reader or host mount | [Source 1](https://support.apple.com/en-mt/guide/disk-utility/dskutl1002/mac) · [Source 2](https://www.qemu.org/docs/master/system/images) |
| Apple sparse images: UDSB sparse bundle and ASIF | disk-image-format | Optional image reader or host mount | [Source 1](https://support.apple.com/en-ie/guide/disk-utility/dskutl11888/mac) · [Source 2](https://support.apple.com/en-mt/guide/disk-utility/dskutl1002/mac) |
| Apple Archive (.aar) | archive-container | Optional container or repository view | [Source 1](https://developer.apple.com/documentation/applearchive) · [Source 2](https://developer.apple.com/documentation/applearchive/archivecompression) |
| LZFSE stream | compression-format | Optional compression transform | [Source 1](https://github.com/lzfse/lzfse/blob/master/README.md) · [Source 2](https://github.com/lzfse/lzfse/blob/master/src/lzfse_internal.h) |

### Encryption and credentials

| Format or profile | Role | Integration proposal | Primary evidence |
| --- | --- | --- | --- |
| age v1 encrypted file format | encrypted-file-envelope | Optional encrypted/backup envelope reader or writer | [Source 1](https://c2sp.org/age@v1.1.0) · [Source 2](https://github.com/C2SP/C2SP/blob/age/v1.1.0/age.md) |
| age native, passphrase, hybrid, and tagged recipient profiles | recipient-profile | Named recipient, key, or algorithm capability | [Source 1](https://github.com/FiloSottile/age/releases) · [Source 2](https://github.com/FiloSottile/age/blob/main/doc/age.1.ronn) |
| age recipient and identity plugin protocol | key-plugin-protocol | Named recipient, key, or algorithm capability | [Source 1](https://c2sp.org/age-plugin) · [Source 2](https://github.com/FiloSottile/age/blob/main/doc/age.1.ronn) |
| OpenPGP RFC 9580 encrypted-message profile | encrypted-file-envelope | Optional encrypted/backup envelope reader or writer | [Source 1](https://www.rfc-editor.org/rfc/rfc9580.html) · [Source 2](https://docs.openpgpjs.org/) |
| OpenPGP RFC 4880-era encrypted message import profiles | encrypted-file-envelope | Optional encrypted/backup envelope reader or writer | [Source 1](https://www.rfc-editor.org/rfc/rfc4880.html) · [Source 2](https://www.rfc-editor.org/rfc/rfc9580.html) |
| OpenPGP post-quantum algorithm extension | encryption-algorithm-extension | Named recipient, key, or algorithm capability | [Source 1](https://www.rfc-editor.org/rfc/rfc9980.html) · [Source 2](https://www.rfc-editor.org/info/rfc9980/) |
| LibrePGP OCB encrypted-data packet profile | encrypted-file-envelope | Optional encrypted/backup envelope reader or writer | [Source 1](https://www.ietf.org/ietf-ftp/internet-drafts/draft-koch-librepgp-06.html) · [Source 2](https://lists.gnupg.org/pipermail/gnupg-announce/2026q3/000516.html) |
| CMS EnvelopedData | encrypted-file-envelope | Optional encrypted/backup envelope reader or writer | [Source 1](https://www.rfc-editor.org/rfc/rfc5652.html) · [Source 2](https://docs.openssl.org/3.5/man1/openssl-cms/) |
| CMS AuthEnvelopedData with AES-GCM/CCM profiles | encrypted-file-envelope | Optional encrypted/backup envelope reader or writer | [Source 1](https://www.rfc-editor.org/rfc/rfc5083.html) · [Source 2](https://www.rfc-editor.org/rfc/rfc5084.html) |
| JSON Web Encryption (JWE) | encrypted-file-envelope | Optional encrypted/backup envelope reader or writer | [Source 1](https://www.rfc-editor.org/rfc/rfc7516.html) · [Source 2](https://github.com/panva/jose) |
| COSE_Encrypt0 | encrypted-file-envelope | Optional encrypted/backup envelope reader or writer | [Source 1](https://www.rfc-editor.org/rfc/rfc9052.html) |
| COSE_Encrypt | encrypted-file-envelope | Optional encrypted/backup envelope reader or writer | [Source 1](https://www.rfc-editor.org/rfc/rfc9052.html) |
| Tink Streaming AEAD wire profiles | streaming-encryption-profile | Optional encryption transform with explicit framing | [Source 1](https://developers.google.com/tink/streaming-aead) · [Source 2](https://developers.google.com/tink/streaming-aead/aes_gcm_hkdf_streaming) |
| libsodium secretstream_xchacha20poly1305 | streaming-encryption-construction | Optional encryption transform with explicit framing | [Source 1](https://doc.libsodium.org/secret-key_cryptography/secretstream) · [Source 2](https://github.com/jedisct1/libsodium.js) |
| Miscreant STREAM construction | streaming-encryption-construction | Optional encryption transform with explicit framing | [Source 1](https://github.com/miscreant/miscreant.js) · [Source 2](https://github.com/miscreant/miscreant.js/blob/develop/README.md) |
| AWS Encryption SDK message format | encrypted-file-envelope | Optional encrypted/backup envelope reader or writer | [Source 1](https://docs.aws.amazon.com/encryption-sdk/latest/developer-guide/message-format.html) · [Source 2](https://docs.aws.amazon.com/encryption-sdk/latest/developer-guide/javascript.html) |
| Amazon S3 Encryption Client object envelope | encrypted-file-envelope | Optional encrypted/backup envelope reader or writer | [Source 1](https://docs.aws.amazon.com/amazon-s3-encryption-client/latest/developerguide/encryption-algorithms.html) · [Source 2](https://docs.aws.amazon.com/amazon-s3-encryption-client/latest/developerguide/java-v4-migration.html) |
| OpenSSL enc salted ciphertext convention | encrypted-file-envelope | Optional encrypted/backup envelope reader or writer | [Source 1](https://docs.openssl.org/3.5/man1/openssl-enc/) |
| AES Crypt .aes stream format 3 | encrypted-file-envelope | Optional encrypted/backup envelope reader or writer | [Source 1](https://www.aescrypt.com/aes_stream_format.html) |
| Tarsnap scrypt encrypted file format | encrypted-file-envelope | Optional encrypted/backup envelope reader or writer | [Source 1](https://www.tarsnap.com/scrypt.html) · [Source 2](https://github.com/Tarsnap/scrypt/blob/master/FORMAT) |
| ZIP traditional encryption (ZipCrypto) | archive-encryption-profile | Named encryption profile within a container | [Source 1](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT) · [Source 2](https://kb.winzip.com/en/130389) |
| ZIP WinZip AES AE-1 and AE-2 | archive-encryption-profile | Named encryption profile within a container | [Source 1](https://www.winzip.com/en/support/aes-encryption/) · [Source 2](https://gildas-lormeau.github.io/zip.js/api/interfaces/ZipWriterConstructorOptions.html) |
| ZIP PKWARE Strong Encryption profile | archive-encryption-profile | Named encryption profile within a container | [Source 1](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT) |
| ZIP central-directory encryption | archive-encryption-profile | Named encryption profile within a container | [Source 1](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT) |
| 7z AES encryption and optional encrypted headers | archive-encryption-profile | Named encryption profile within a container | [Source 1](https://www.7-zip.org/7z.html) · [Source 2](https://github.com/ip7z/7zip/blob/b88c6bc09339de32f7d18bbab900686b244f42ba/CPP/7zip/Crypto/7zAes.cpp) |
| RAR 5 encryption and encrypted-header profiles | archive-encryption-profile | Named encryption profile within a container | [Source 1](https://www.rarlab.com/technote.htm) · [Source 2](https://www.win-rar.com/encryption-faq.html) |
| Apple Encrypted Archive (AEA) profiles | archive-encryption-profile | Named encryption profile within a container | [Source 1](https://developer.apple.com/documentation/applearchive/archiveencryptioncontext/profile-swift.struct) · [Source 2](https://developer.apple.com/documentation/applearchive/encrypting-and-decrypting-a-single-file) |
| Minisign detached signature format | signature-only | Optional signature/evidence verification | [Source 1](https://jedisct1.github.io/minisign/) |
| OpenBSD signify signatures | signature-only | Optional signature/evidence verification | [Source 1](https://man.openbsd.org/signify) |
| Amazon S3 SSE-S3 | provider-encryption-control | Provider configuration/control | [Source 1](https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingServerSideEncryption.html) · [Source 2](https://docs.aws.amazon.com/AmazonS3/latest/API/API_UpdateObjectEncryption.html) |
| Amazon S3 SSE-KMS | provider-encryption-control | Provider configuration/control | [Source 1](https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingKMSEncryption.html) · [Source 2](https://docs.aws.amazon.com/AmazonS3/latest/API/API_UpdateObjectEncryption.html) |
| Amazon S3 dual-layer SSE-KMS (DSSE-KMS) | provider-encryption-control | Provider configuration/control | [Source 1](https://docs.aws.amazon.com/AmazonS3/latest/userguide/serv-side-encryption.html) · [Source 2](https://docs.aws.amazon.com/AmazonS3/latest/userguide/specifying-dsse-encryption.html) |
| Amazon S3 SSE-C | provider-encryption-control | Provider configuration/control | [Source 1](https://docs.aws.amazon.com/AmazonS3/latest/userguide/specifying-s3-c-encryption.html) |
| Client-side envelope encryption with KMS-managed wrapping keys | provider-encryption-control | Provider configuration/control | [Source 1](https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingClientSideEncryption.html) · [Source 2](https://aws.amazon.com/blogs/storage/understanding-amazon-s3-client-side-encryption-options/) |
| AEAD cipher constructions | crypto-building-block | Supporting reference/dependency | [Source 1](https://csrc.nist.gov/pubs/sp/800/38/d/final) · [Source 2](https://csrc.nist.gov/pubs/sp/800/38/d/r1/2prd) |
| Password key derivation: Argon2, scrypt, and PBKDF2 | crypto-building-block | Supporting reference/dependency | [Source 1](https://www.rfc-editor.org/info/rfc9106/) · [Source 2](https://www.rfc-editor.org/info/rfc7914/) |
| Hashes, keyed MACs, and HKDF | crypto-building-block | Supporting reference/dependency | [Source 1](https://www.rfc-editor.org/rfc/rfc2104.html) · [Source 2](https://www.rfc-editor.org/info/rfc5869/) |
| Hybrid Public Key Encryption (HPKE) | crypto-building-block | Supporting reference/dependency | [Source 1](https://www.rfc-editor.org/rfc/rfc9180.html) |
| PKCS #8 private-key containers | key-credential-container | Optional credential/container import | [Source 1](https://www.rfc-editor.org/info/rfc5958/) · [Source 2](https://www.rfc-editor.org/rfc/rfc9939.html) |
| PKCS #12 / PFX credential bundles | key-credential-container | Optional credential/container import | [Source 1](https://www.rfc-editor.org/info/rfc7292/) · [Source 2](https://www.rfc-editor.org/info/rfc9879/) |
| PEM-style textual encoding and ASN.1 DER | encoding-only | Supporting reference/dependency | [Source 1](https://www.rfc-editor.org/rfc/rfc7468.html) |
| JSON Web Key / JSON Web Key Set | key-credential-container | Optional credential/container import | [Source 1](https://www.rfc-editor.org/rfc/rfc7517.html) |
| COSE_Key | key-credential-container | Optional credential/container import | [Source 1](https://www.rfc-editor.org/rfc/rfc9052.html) |
| KeePass KDBX 4.1 credential database | key-credential-container | Optional credential/container import | [Source 1](https://keepass.info/help/kb/kdbx.html) · [Source 2](https://keepass.info/help/kb/kdbx_4.html) |
| ETSI ASiC-S / ASiC-E signed ZIP containers | signature-only | Optional signature/evidence verification | [Source 1](https://www.etsi.org/deliver/etsi_en/319100_319199/31916201/01.01.01_60/en_31916201v010101p.pdf) · [Source 2](https://portal.etsi.org/webapp/WORKPROGRAM/TUBEReport.asp?SearchPage=TRUE&butExpertSearch=Search&includeNonActiveTB=FALSE&includeSubProjectCode=FALSE&optDisplay=ALL&qCLUSTER_BOOLEAN=OR&qEND_CURRENT_STATUS_CODE=11+WI%3BM58&qETSI_ALL=&qFREQUENCIES_BOOLEAN=OR&qINCLUDE_MOVED_ON=&qINCLUDE_SUB_TB=True&qKEYWORD_BOOLEAN=&qREPORT_TYPE=SUMMARY&qSORT=REFNB&qSTOPPING_OUTDATED=&qSTOP_FLG=N&qTB_ID=607%3BESI) |
| Evidence Record Syntax (ERS) and XMLERS | signature-only | Optional signature/evidence verification | [Source 1](https://www.rfc-editor.org/info/rfc4998/) · [Source 2](https://www.rfc-editor.org/info/rfc6283/) |

### Vaults and volumes

| Format or profile | Role | Integration proposal | Primary evidence |
| --- | --- | --- | --- |
| Cryptomator vault | encrypted-vault | Optional encrypted vault view | [Source 1](https://docs.cryptomator.org/security/architecture/) · [Source 2](https://docs.cryptomator.org/security/vault/) |
| gocryptfs forward format | encrypted-vault | Optional encrypted vault view | [Source 1](https://nuetzlich.net/gocryptfs/forward_mode_crypto/) |
| gocryptfs reverse view | encrypted-vault | Optional encrypted vault view | [Source 1](https://nuetzlich.net/gocryptfs/reverse_mode_crypto/) |
| rclone crypt file and name format | encrypted-vault | Optional encrypted vault view | [Source 1](https://rclone.org/crypt/) |
| EncFS legacy V4/V5/V6 | encrypted-vault | Optional encrypted vault view | [Source 1](https://github.com/vgough/encfs) · [Source 2](https://github.com/vgough/encfs/blob/master/security.md) |
| EncFS V7 | encrypted-vault | Optional encrypted vault view | [Source 1](https://github.com/vgough/encfs) · [Source 2](https://github.com/vgough/encfs/blob/master/security.md) |
| CryFS encrypted block tree | encrypted-vault | Optional encrypted vault view | [Source 1](https://www.cryfs.org/howitworks) · [Source 2](https://github.com/cryfs/cryfs) |
| securefs lite and full formats | encrypted-vault | Optional encrypted vault view | [Source 1](https://github.com/netheril96/securefs) · [Source 2](https://github.com/netheril96/securefs/blob/master/docs/design.md) |
| Linux fscrypt policies | encrypted-filesystem | Host filesystem or explicit image integration | [Source 1](https://docs.kernel.org/filesystems/fscrypt.html) |
| eCryptfs stacked filesystem | encrypted-filesystem | Host filesystem or explicit image integration | [Source 1](https://docs.kernel.org/security/keys/ecryptfs.html) · [Source 2](https://docs.kernel.org/filesystems/ecryptfs.html) |
| LUKS1 / LUKS2 with dm-crypt | encrypted-volume | Host filesystem or explicit image integration | [Source 1](https://gitlab.com/cryptsetup/cryptsetup/-/blob/main/man/cryptsetup.8.adoc) · [Source 2](https://gitlab.com/cryptsetup/cryptsetup/blob/master/docs/on-disk-format-luks2.pdf) |
| VeraCrypt volumes | encrypted-volume | Host filesystem or explicit image integration | [Source 1](https://veracrypt.io/en/VeraCrypt%20Volume%20Format%20Specification.html) |
| BitLocker volumes | encrypted-volume | Host filesystem or explicit image integration | [Source 1](https://learn.microsoft.com/en-us/windows/security/operating-system-security/data-protection/bitlocker/configure) · [Source 2](https://learn.microsoft.com/en-us/windows/security/operating-system-security/data-protection/bitlocker/operations-guide?tabs=powershell) |
| APFS encryption / FileVault | encrypted-volume | Host filesystem or explicit image integration | [Source 1](https://support.apple.com/guide/security-pdf/volume-encryption-with-filevault-sec4c6dc1b6e/1/web/1) · [Source 2](https://developer.apple.com/documentation/foundation/about-apple-file-system?changes=_3) |
| Windows EFS encrypted files | encrypted-filesystem | Host filesystem or explicit image integration | [Source 1](https://learn.microsoft.com/en-us/windows/win32/fileio/file-encryption) |
| Encrypted Apple disk images and sparse bundles | encrypted-volume | Host filesystem or explicit image integration | [Source 1](https://support.apple.com/en-ie/guide/disk-utility/dskutl11888/mac) |
| Android ADB .ab backup envelope | backup-envelope | Optional encrypted/backup envelope reader or writer | [Source 1](https://android.googlesource.com/platform/frameworks/base/+/fae78ad75ae4e72133d44ae821399ef9a8236321/services/backup/java/com/android/server/backup/fullbackup/PerformAdbBackupTask.java) · [Source 2](https://developer.android.com/about/versions/12/behavior-changes-12) |

### Repositories and preservation

| Format or profile | Role | Integration proposal | Primary evidence |
| --- | --- | --- | --- |
| restic repository | backup-repository | Optional container or repository view | [Source 1](https://restic.readthedocs.io/en/stable/100_references.html) · [Source 2](https://restic.readthedocs.io/en/stable/050_restore.html) |
| Borg repository and archive snapshots | backup-repository | Optional container or repository view | [Source 1](https://borgbackup.readthedocs.io/en/stable/internals/data-structures.html) · [Source 2](https://borgbackup.readthedocs.io/en/stable/internals/security.html) |
| Kopia repository | backup-repository | Optional container or repository view | [Source 1](https://kopia.io/docs/advanced/architecture/) · [Source 2](https://kopia.io/docs/advanced/encryption/) |
| Duplicacy repository | backup-repository | Optional container or repository view | [Source 1](https://github.com/gilbertchen/duplicacy) · [Source 2](https://github.com/gilbertchen/duplicacy/wiki/Snapshot-Format) |
| Duplicati backup volumes | backup-repository | Optional container or repository view | [Source 1](https://docs.duplicati.com/technical-details/understanding-backup) · [Source 2](https://docs.duplicati.com/technical-details/understanding-restore) |
| Tarsnap archive and chunk model | backup-repository | Optional container or repository view | [Source 1](https://www.tarsnap.com/design.html) · [Source 2](https://www.tarsnap.com/client-actions.html) |
| Duplicity full and incremental backup chains | backup-repository | Optional container or repository view | [Source 1](https://duplicity.us/stable/duplicity.1.html) · [Source 2](https://duplicity.readthedocs.io/en/latest/difftar_format.html) |
| BagIt 1.0 package | preservation-package | Optional container or repository view | [Source 1](https://www.rfc-editor.org/rfc/rfc8493.txt) · [Source 2](https://github.com/LibraryOfCongress/bagit-python) |
| Oxford Common File Layout 1.1 | preservation-package | Optional container or repository view | [Source 1](https://ocfl.io/latest/spec/) · [Source 2](https://ocfl.io/1.1/spec/) |
| WARC web archive records | preservation-package | Optional container or repository view | [Source 1](https://iipc.github.io/warc-specifications/specifications/warc-format/warc-1.1/) · [Source 2](https://github.com/webrecorder/warcio) |
| Web Archive Collection Zipped (WACZ) | preservation-package | Optional container or repository view | [Source 1](https://specs.webrecorder.net/wacz/1.1.1/) · [Source 2](https://github.com/webrecorder/py-wacz) |
| RO-Crate research-object metadata | metadata-standard | Optional package metadata/validation | [Source 1](https://www.researchobject.org/ro-crate/specification/1.3/index.html) · [Source 2](https://www.researchobject.org/ro-crate/specification/1.3/structure.html) |
| E-ARK information packages and CSIP | preservation-package | Optional container or repository view | [Source 1](https://earkcsip.dilcis.eu/) |
| PREMIS preservation metadata | metadata-standard | Optional package metadata/validation | [Source 1](https://www.loc.gov/standards/premis/) · [Source 2](https://www.loc.gov/standards/premis/v3/index.html) |
| METS structural metadata | metadata-standard | Optional package metadata/validation | [Source 1](https://www.loc.gov/standards/mets/) · [Source 2](https://www.loc.gov/standards/mets/mets2.html) |
| OCI image layout and filesystem layers | filesystem-layer-layout | Optional container or repository view | [Source 1](https://github.com/opencontainers/image-spec/blob/main/image-layout.md) · [Source 2](https://github.com/opencontainers/image-spec/blob/main/layer.md) |
| IPLD CAR version 1 | content-addressed-archive | Optional container or repository view | [Source 1](https://ipld.io/specs/transport/car/carv1/) · [Source 2](https://github.com/ipld/js-car) |
| IPLD CAR version 2 | content-addressed-archive | Optional container or repository view | [Source 1](https://ipld.io/specs/transport/car/carv2/) · [Source 2](https://github.com/ipld/go-car) |

### Implementation candidates

| Implementation | Read capability | Write capability | Evidence |
| --- | --- | --- | --- |
| libarchive native C library | Multi-format reader, including tar/PAX/cpio, ZIP/ZIPX, 7z, RAR4/5, ISO, CAB, WARC and XAR. RAR support has documented limitations. | Creates tar/PAX/cpio, ZIP/ZIPX, 7z, ISO, WARC, XAR and other listed formats. RAR creation is not listed. No general in-place archive update API. | [Primary source](https://www.libarchive.org/) |
| 7-Zip native CLI and libraries | Unpacks its writable formats and a larger read-only set including RAR, CAB, ISO/UDF, disk images and several filesystem images. | Official list: 7z, XZ, BZIP2, GZIP, TAR, ZIP and WIM. Read support for a format does not imply creation support. | [Primary source](https://www.7-zip.org/) |
| libzip native ZIP library | ZIP reading, member lookup, metadata and encrypted-member reads. | Create and modify ZIP archives, including add/replace/delete and explicit commit/discard. | [Primary source](https://libzip.org/documentation/) |
| zip.js | ZIP/ZIP64 and split ZIP, STORE/DEFLATE and documented DEFLATE64 decoding; metadata enumeration and streamed member extraction. | ZIP/ZIP64 creation, streamed entry output, parallel compression and split-output options; changing an existing archive normally creates replacement output. | [Primary source](https://gildas-lormeau.github.io/zip.js/) |
| fflate | ZIP STORE/DEFLATE plus gzip, zlib and raw DEFLATE; complete-buffer and streaming unzip APIs. | ZIP creation and gzip/zlib/DEFLATE compression, synchronous, callback-based and streaming forms. | [Primary source](https://github.com/101arrowz/fflate) |
| JSZip | Classic ZIP, data descriptors and limited ZIP64 loading. STORE and DEFLATE. | Create/edit the logical file set and generate a new ZIP; streamFiles uses data descriptors. | [Primary source](https://stuk.github.io/jszip/) |
| Web CompressionStream / DecompressionStream | Streaming decompression of the standard gzip, deflate (zlib framing) and deflate-raw formats; no archive-member parser. | Streaming compression of those formats; no ZIP/tar directory, entry metadata, append or update API. | [Primary source](https://compression.spec.whatwg.org/) |
| Deno standard library @std/tar | UntarStream parses a tar byte stream into entries and member streams. | TarStream creates tar from typed file/directory/link inputs. File input requires path, size and readable content. | [Primary source](https://jsr.io/@std/tar) |
| Deno @std/archive (historical API) | Historical tar extraction API. | Historical Tar append/getReader API; not a current general ZIP/compression package. | [Primary source](https://jsr.io/@std/archive) |
| @deno-library/compress | Documented tar/tgz/ZIP, gzip/deflate and Brotli utilities. | Corresponding compression/archive convenience operations are documented; support depends on each implementation. | [Primary source](https://jsr.io/@deno-library/compress) |
| tar-stream | USTAR with PAX extended-header support. | pack generates tar; modifications use extract plus pack to create replacement output. | [Primary source](https://github.com/mafintosh/tar-stream) |
| libarchive.js / nika-begiashvili/libarchivejs | README lists ZIP, 7z, RAR4/5 and tar extraction; listing and individual-member extract methods are documented. | Version-2 documentation exposes Archive.write with format/compression choices. Do not infer RAR creation or every native writer from the broad read-format list. | [Primary source](https://github.com/nika-begiashvili/libarchivejs) |
| use-strict/7z-wasm | Publisher states the formats supported by its compiled full 7zz CLI; verify against embedded 24.09, not current 26.05. | CLI invocation can create archives using the embedded 7zz writer set; no uniform JavaScript archive-update API. | [Primary source](https://github.com/use-strict/7z-wasm) |
| node-unrar-js | RAR listing/extraction from an ArrayBuffer or native file; the README explicitly excludes multi-volume archives. | No RAR creation. This is an extractor. | [Primary source](https://github.com/YuJianrong/node-unrar.js) |
