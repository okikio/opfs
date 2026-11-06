# Memcached independent client fixture

The current provider test lets one implementation write a value and the other read every byte. The project client is
compared with native libmemcached against a private Memcached 1.6.45 server. Testcontainers owns creation and cleanup;
`tests/provider/memcached.ts` owns bounded commands and resource checks. Run the repository's `test:memcached-provider`
task from `deno.json` in an environment with Docker and the reviewed acquisition network access.

`Dockerfile` acquires the test-only C toolchain and libmemcached from signed Debian repositories inherited from the same
immutable Node26 base as the FTP fixture. It preserves downloaded package SHA-256 values, installed versions,
source/binary hashes, compiler, OS, sources and signed repository metadata. These identify the actual build; package
versions are not falsely presented as immutable before acquisition. The test prints bounded receipts separately from
protocol results. No runtime dependency is added to the library.

`oracle.c` is a small public-ABI caller. Libmemcached owns protocol bytes, framing and CAS parsing. The shim sets
classic ASCII, `SUPPORT_CAS` and acknowledged writes, then uses `set` or one-key `mget`/`fetch_result`. It checks the
exact returned key, bounds the full value to 1 MiB, preserves uint64 CAS as decimal text, and drains the final fetch
result. A base64 representation carries arbitrary bytes back to TypeScript. The native library owns its result storage
until the shim frees it. Input storage and encoded output are bounded; the provider applies a 20-second command
deadline, a 2 MiB receipt bound and Docker resource checks.

The public API contracts are documented in upstream
[retrieval](https://awesomized.github.io/libmemcached/libmemcached/memcached_get.html),
[result ownership and CAS](https://awesomized.github.io/libmemcached/libmemcached/memcached_result_st.html),
[behaviors](https://awesomized.github.io/libmemcached/libmemcached/memcached_behavior.html) and
[statistics](https://awesomized.github.io/libmemcached/libmemcached/memcached_stats.html). Installed reviewed headers
own the ABI; this repository does not copy upstream runtime code.

`provider.ts.snapshot` is the exact former provider, including its embedded Python/pymemcache harness, retained as inert
evidence. `source-map.json` records the original length/hash and current files. Existing `independent.json` and
`provenance.json` are frozen historical pymemcache proof. A new successful libmemcached run must be qualified
separately; the new source itself is not evidence of a native test pass. No Python code is executed by the current
fixture.
