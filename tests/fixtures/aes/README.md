# Create native WinZip AES fixtures

`create.ts` asks 7-Zip to produce AES-128/192/256 STORED and AES-256 DEFLATE ZIP archives. Independent libarchive
extraction compares every original payload byte. AE-1 and ordinary version-needed controls copy the native image and
change only the specified version/CRC metadata; encrypted bytes and authentication tags must remain unchanged. They are
authored adaptations over genuine ciphertext, not direct AE-1 writer output.

Run from the repository root in a disposable runner with reviewed 7zip, libarchive tools and OpenSSL 3:

```sh
deno run --allow-read --allow-write --allow-env --allow-run tests/fixtures/aes/create.ts \
  --seven /usr/bin/7zz --bsdtar /usr/bin/bsdtar --openssl /usr/bin/openssl --output /tmp/aes-new.json
```

The new port also checks the encrypted envelope through OpenSSL CLI primitives. OpenSSL supplies PBKDF2-SHA1 derived
keys, HMAC-SHA1 and AES encryption of explicit counter blocks. Authored TypeScript glue locates the small ZIP profile,
constructs WinZip's little-endian counters, XORs the keystream, and compares the complete original plaintext. DEFLATE
plaintext is inflated with built-in zlib under a 64 KiB output limit. Using raw AES blocks avoids assuming that a native
CTR mode increments its counter in WinZip's byte order. The OpenSSL operations are not another ZIP parser; libarchive
remains the independent complete-archive consumer.

The CLI contracts are documented by OpenSSL's [key derivation command](https://docs.openssl.org/3.0/man1/openssl-kdf/),
[digest/MAC command](https://docs.openssl.org/3.0/man1/openssl-dgst/) and
[block encryption command](https://docs.openssl.org/3.0/man1/openssl-enc/). Record the actual installed version/provider
for qualification. The selected historical format uses 1000 PBKDF2 iterations and short salts; it is not a new
encryption-policy recommendation or a claim about acceptance by a FIPS-restricted provider.

Each command has a 30-second deadline and a 4 MiB captured-output budget. The authored envelope locator admits at most
16 entries and a 1 MiB image. The tool owns and removes its temporary tree, and imports no candidate implementation. The
archive size is checked before materialization. `--output` must name a new file; exclusive creation refuses to overwrite
existing evidence. Deadlines kill the direct child with SIGKILL. These limits do not impose a filesystem quota. All
passwords and generated keys are public fixture data. Randomized salts and timestamps can change archive hashes on each
run while the original plaintext stays fixed.

The TypeScript producer and added OpenSSL route have not yet run. Existing `independent.json` and `provenance.json`
retain the earlier 7-Zip/libarchive run. Its exact executed source remains inert `create.py.snapshot`, matching the
receipt's original `create.py` hash. Keep new output separate until a bounded native qualification records source/tool
hashes, versions, all consumer results, unchanged ciphertext across adaptations and complete payload comparisons. No
historical fixture or receipt has been rewritten.
