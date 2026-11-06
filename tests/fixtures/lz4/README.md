# Produce native LZ4 frame evidence

Run the TypeScript tool in the reviewed disposable native-tool environment:

```sh
node tests/fixtures/lz4/create.ts --lz4 /usr/bin/lz4 --xxhsum /usr/bin/xxhsum --output /tmp/lz4-next.json
```

The native CLI writes independent and linked blocks, four block-size limits, empty input, literal input and overlapping
matches. Its decoder must return every original byte. Native `xxhsum` supplies the XXH32 values and the checksums for
explicitly authored header mutation controls. These controls are not claims that a native writer accepted an invalid
size or a dictionary-bearing frame. Each native command has a 90-second deadline and a 16 MiB capture ceiling per pipe;
the outer container supplies the aggregate memory and process limits.

The new authored xorshift32 byte recipe does not reproduce Python's historical random sequence. The CLI decoder also
replaces the old direct C-API binding. Both use the native LZ4 frame engine; this does not establish two independent
native codec implementations. The producer imports no OPFS codec.

`create.py.snapshot` preserves the exact previous executed producer. Existing `independent.json` and `provenance.json`
remain the authority for that historical run, including its full-byte native FFI comparisons. A new output belongs in a
separate path until its source, native tools and output have been qualified. A TypeScript port alone does not establish
successful new native execution.
