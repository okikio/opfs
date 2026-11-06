# Independent ZIP preview fixture

`preview.zip` was produced with Python's standard-library `zipfile` on 2026-11-05. It contains two stored members with
fixed timestamps: `unrelated.bin` has 1,048,576 ASCII Z bytes; `preview.txt` has the UTF-8 bytes of
`preview from a revision-bound remote archive\n`. The trailing newline is one byte, not a literal backslash-n. The
producer is independent of OPFS's ZIP parser. No external corpus, executable content or third-party license is used.

SHA-256: `f9a09febfc9fdd377d8d35ff1a3c8b63c82b3de0d73273fa0a455d74b29bc5bb`.

The container integration test uploads this fixture, lists its directory and reads only the selected text prefix. The
byte oracle is authored independently in the test, and the recorded range budget is smaller than the unrelated member.
It then mutates the source to test that an old snapshot never returns new content. This is an emulator workflow check,
not Google Cloud IAM/CORS or format-security certification.
