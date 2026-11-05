# Independent ARJ fixtures

`create.py` invokes signed-distribution ARJ and independently extracts each archive with 7zip. It requires the same
exact authored file set and every original byte from both consumers. No candidate TypeScript reader is imported or used
to produce expectations. The script and native inputs are authored for these tests; all names are inert ASCII paths
owned by the temporary fixture directory.

The native tools run only in a bounded, offline, disposable test container. Their binaries are not bundled, imported, or
installed as production dependencies.

The first successful native pass created STORED and requested-method-1 archives. Their actual basic prefixes are main 34
bytes and member 46 bytes; all extension chains are zero length. Method 1 is used for `many.bin`; the producer falls
back to method 0 on smaller files. Do not infer wire method solely from the requested CLI switch. The final expanded
pass additionally contains a genuine type-3 empty directory, a CRLF archive comment and a CRLF member comment on
`tiny.txt`. Both consumers create that empty directory; the reader checks exact comment bytes from native headers.
Literal `emptydir` was initially expanded by ARJ to its empty contents and failed. The reviewed literal argv `emptydi?`
selects the owned directory record instead. `arj c -jzFILE` applies the file comment after creation; supplying `-jzFILE`
to add alone did not populate it.

The candidate reader does not implement the native command line, compressed methods, encryption, multivolume,
secure/recovery, chapter or UNIX special files. Any nonzero structural extension causes explicit refusal. This is a
selected read-only profile, not complete ARJ conformance.

`provenance.json` records upstream grammar sources, producer identity and script hashes, package artifacts,
compact/formatted fixture hashes, and actual execution receipts. Authored adversarial controls in `tests/arj.test.ts`
use an independent table-driven CRC plus the published CRC32 `123456789` vector. Native full-byte interoperability
remains the principal proof that real archive records work.
