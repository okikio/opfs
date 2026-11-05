# Native Git LFS pointer oracles

`hello.bin` contains the six bytes `hello` plus LF. Git LFS3.8.1 generated `hello.pointer` using
`git lfs pointer --file=hello.bin`. The empty fixture used `git lfs clean -- empty.bin < empty.bin`, which passes the
empty file through unchanged. That CLI release's `pointer --file=empty.bin` returns `clean: pointer error`; this fixture
records the observed clean behavior instead of inventing pointer-command success.

Both resulting pointer files passed `git lfs pointer --check --strict --file=<pointer>`. Production codecs did not
create the expected bytes. Commands ran inside a disposable Git repository, without changing this checkout's Git
configuration. `manifest.json` records the observed producer version, commands, byte counts and SHA-256 hashes. The
fixture-local `.gitattributes` protects the byte oracles from newline conversion on Windows.

These files prove canonical pointer byte interoperability and empty pass-through behavior. They do not prove a remote
object's availability or authorization. The separate Gitea Testcontainers test owns real basic-transfer upload/download
proof with another independent official CLI inside the container.
