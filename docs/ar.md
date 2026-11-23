# Preview an ar archive

```ts
import { createBlobSource } from "@okikio/opfs/source";
import { createArchiveLedger, openAr } from "@okikio/opfs/archive/ar";

export async function preview(archiveBytes: ArrayBuffer): Promise<Uint8Array | undefined> {
  const ledger = createArchiveLedger({
    maxSourceBytes: 4 * 1024 * 1024,
    maxRequests: 512,
    maxDecodedBytes: 4 * 1024 * 1024,
    maxOutputBytes: 4096,
  });
  const archive = await openAr(createBlobSource(new Blob([archiveBytes])), { ledger });
  console.table(archive.entries);
  const file = archive.entries.find((entry) => entry.kind === "file");
  if (!file) return undefined;
  const result = await archive.read(file.id, { offset: 0, length: Math.min(4096, file.size), ledger });
  console.log(result.integrity); // "none": ar has no payload checksum.
  return result.bytes;
}
```

`openAr` indexes one normal physical archive, such as a static library or Debian package. It reads the magic, fixed
headers, alignment bytes and bounded long names without reading ordinary file bodies. `read(id, { offset, length })`
retrieves exactly the selected range. IDs retain archive order; duplicate names retain separate IDs. Names and Unix
ownership/mode/time fields are untrusted data, never instructions to access a host path or create an object.
Modification time uses Unix seconds. Blank numeric metadata stays absent.

The reader supports short names, GNU/SVR4 `//` name tables with `/offset` references, and BSD `#1/length` inline names.
For BSD, `storedSize` includes filename bytes, while `offset` and `size` describe only the payload. Trailing NUL
alignment bytes in BSD names are accepted; interior NULs, invalid UTF-8 and newline-separated names refuse. GNU
references must point to validated record starts, not arbitrary suffixes of a table entry. One final table-alignment
linefeed is accepted, as produced by GNU/LLVM writers.

Name and conventional symbol-table records have explicit `name-table` or `symbol-table` kinds. Symbol contents are
opaque and skipped during indexing: the parser does not validate symbol indexes or promise that a linker can use them.
These special records cannot be read or opened as ordinary members. Thin archives refuse at the signature because their
members reference external files. AIX, COFF-specific name-table encodings, SFX prefixes and concatenated archives are
outside this profile. A header terminator is a backtick followed by linefeed; odd stored bodies require a linefeed
alignment byte, including at EOF.

## Preview a nested package member

Debian packages normally place compressed TAR archives inside ar. This function streams only `control.tar.gz` through
gzip and TAR, without materializing the package or compressed member. It collects the control file while completing the
scan so the gzip footer is checked.

```ts
import { createBlobSource } from "@okikio/opfs/source";
import { openAr } from "@okikio/opfs/archive/ar";
import { readCompressedTar } from "@okikio/opfs/archive/compress";

export async function readControl(archiveBytes: ArrayBuffer): Promise<Uint8Array | undefined> {
  const archive = await openAr(createBlobSource(new Blob([archiveBytes])));
  const entry = archive.entries.find((entry) => entry.kind === "file" && entry.name === "control.tar.gz");
  if (!entry) return undefined;
  const member = archive.member(entry.id, {
    maxSourceBytes: 4 * 1024 * 1024,
    maxRequests: 256,
    maxDecodedBytes: 4 * 1024 * 1024,
    maxOutputBytes: 4 * 1024 * 1024,
  });
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (offset === member.size) {
        controller.close();
        return;
      }
      const length = Math.min(65536, member.size - offset);
      controller.enqueue(await member.read(offset, length));
      offset += length;
    },
  });
  let control: Uint8Array | undefined;
  const result = await readCompressedTar(stream, "gzip", async (entry, body) => {
    if (entry.kind !== "file" || (entry.name !== "control" && entry.name !== "./control")) return;
    if (control !== undefined) throw new Error("Package contains duplicate control files.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of body) {
      chunks.push(chunk);
      size += chunk.length;
    }
    control = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
      control.set(chunk, at);
      at += chunk.length;
    }
  }, {
    compression: {
      maxSourceBytes: 4 * 1024 * 1024,
      maxDecodedBytes: 16 * 1024 * 1024,
      maxOutputBytes: 16 * 1024 * 1024,
    },
    tar: { maxSourceBytes: 16 * 1024 * 1024, maxDecodedBytes: 16 * 1024 * 1024, maxOutputBytes: 65536 },
  });
  console.log(result.compression.integrity); // "gzip-crc32" after successful full EOF.
  return control;
}
```

This is an archive preview, not a Debian signature verifier or package installer. Outer ar integrity remains `none`. A
gzip footer supplies accidental-corruption evidence only. Returning `false` from the TAR visitor cancels early and
leaves compression integrity `pending`; it does not certify unread bytes. The package source must represent a stable
snapshot throughout nested reads.

## Budgets and ownership

Each open or direct read defaults to 64 MiB source bytes, 4096 requests, 64 MiB decoded bytes and 16 MiB output bytes.
Opening additionally allows 100,000 physical records, at most that many GNU name-table records, 64 KiB per encoded name,
1 MiB aggregate logical name bytes and a 1 MiB GNU table. BSD trailing NUL name alignment counts toward both name
limits. Table names and subsequent references both count toward the aggregate logical name allowance, even when the
decoded string is reused. Only one GNU name table before ordinary files is supported.

`member(id, options)` returns a known-size borrowed `ByteSourceType`. Each read enforces the exact selected member
extent. Its captured policy and ledger apply across **all** reads of that member source; a fresh per-read work budget
does not reset its aggregate allowance. Identity is derived only when the parent has an identity, and contains the
parent identity plus physical offset/size, never the member name. Only an actual parent stability declaration is
inherited. An explicitly accepted unverified parent still produces an unverified member; nested readers must opt in
separately.

Keep nested logical budgets distinct as in the example. An inner TAR/compression reader counts the work it admits, while
the member source counts its own reads; sharing one ledger across those layers conservatively charges both boundaries.
To count physical transport requests once across nested readers, wrap the original source with `budgetSource` and a
`createSourceBudget` ledger before opening it. Archive counters describe requested extents; an injected provider can
have additional hidden work that it must account separately.

The source and all its resources stay caller-owned. There is no close operation, worker, registry or automatic
extraction. Direct reads observe their own signal. A member source combines its creation signal with each read signal;
either can abort pending reads and neither transfers source disposal ownership. Aborts/source errors propagate
unchanged. Byte/record limits do not promise a hard heap or CPU-time bound. Small output ranges cost only their
requested bytes because ar has no format checksum requiring a full-file scan.

## Interoperability evidence

`tests/fixtures/ar/create.py` creates normal GNU archives with GNU binutils ar 2.40 and BSD archives with LLVM ar
14.0.6, then extracts every payload with the other implementation and compares all bytes to original binary inputs.
Tests include empty and odd-size files, a 128 KiB member, exact 16-byte names, spaces, UTF-8 and Python-stdlib-produced
nested gzip/TAR. Fixed original wire controls cover table references, padding, numeric parsing, duplicate IDs, malformed
extents, limits and cancellation.

Unfiltered bsdtar 3.6.2 extraction of the GNU fixture fails when it exposes `//` as a pathname; that diagnostic is
retained in the fixture rather than reported as a successful consumer. Cross GNU/LLVM extraction is the successful
full-payload interoperability proof. BSD bsdtar extraction also succeeds. The provenance receipt pins script, JSON and
individual archives. Signed Debian packages are test tools, not runtime dependencies. The local tools image ID is
`sha256:8c39a57d8b46ec7a906faf9bd37bb8969bb848123e0e4082145dd2902b42199f`; it is a local installed-tools snapshot, not a
public pullable reproducibility guarantee.

The wire profile follows primary [FreeBSD ar(5)](https://github.com/freebsd/freebsd-src/blob/main/share/man/man5/ar.5),
[LLVM archive reader/writer contracts](https://github.com/llvm/llvm-project/tree/main/llvm/lib/Object) and
[GNU binutils ar documentation](https://sourceware.org/binutils/docs/binutils/ar.html). No upstream parser code is
copied.
