# Native FTP and TLS session-reuse fixture

The current Docker recipe runs native ProFTPD with its native TLS module. `server.ts` creates the test-only account,
OpenSSL certificate and configuration, then launches ProFTPD. It implements no FTP commands. `client.ts` uses native
libcurl to seed files through STOR and verify candidate uploads through RETR. Upload bytes enter curl through stdin.
Neither native program imports the candidate protocol implementation.

The container runs UID/GID65534 with all capabilities dropped and `no-new-privileges`. Its login home is
`/tmp/ftp-home`. This is a real container pathname: nonroot ProFTPD cannot chroot, so PWD does not expose a virtual `/`.
Native Directory limits deny DIRS, READ and WRITE operations under `/`, then allow them only under that home. Inherited
`AllowOverride off` prevents uploaded `.ftpaccess` files from changing those rules. This is an operation policy inside a
disposable container, not an OS chroot or a general host filesystem sandbox.

The provider suite retains plain EPSV/MLST/MLSD/REST, candidate STOR with independent native RETR, trusted explicit TLS,
and untrusted-certificate refusal. TLS is deliberately restricted to 1.2. The default mod_tls requirement to reuse the
authenticated control session is retained; `NoSessionReuseRequired` is never set. The injected Node transport still
requires `isSessionReused()` for both private data connections. A separate case requires actual native550 refusals for
CWD `/tmp`, RETR of world-readable `/etc/passwd`, and STOR under world-writable `/tmp`, plus candidate outside-home
calls. OS permissions alone would allow those outside-home accesses, so native refusal is required before this profile
qualifies.

Run the existing provider test task from the repository root. Testcontainers owns build, startup, mapped ports and
container cleanup. Each native setup/client command has a finite timeout, SIGKILL and bounded captured diagnostics. The
native server has a 2 MiB diagnostic ceiling; Testcontainers bounds its startup and container memory/CPU. The fixture
alone translates passive ports 30000–30001 to their ephemeral host mappings. Production FTP peer pinning is unchanged.

The immutable official Node26 base matches the already reviewed provider fixture base. Only inherited signed Debian APT
sources install ProFTPD, its TLS module, OpenSSL and curl. `/fixture/receipts` retains downloaded deb digests, installed
package versions, source configuration and signed InRelease documents. `/tmp/ftp-provenance.json` adds actual native
versions, binary/module/source/configuration hashes. The host fixture exposes those receipts as `provenance`.
Distribution versions can change between builds; the image digest does not pin future APT results.

The current native profile passed all five provider cases, including both TLS1.2 private data-session reuse checks and
native outside-home directory/read/write refusals. This qualifies the exercised disposable profile, not other servers,
TLS versions or deployment policies. Historical `Dockerfile.snapshot`, `server.py.snapshot` and
`requirements.txt.snapshot` preserve the former pyftpdlib, Python ftplib and hash-pinned TLS recipe exactly. That old
profile provided a virtual root; its namespace and past results must not be attributed to the new native profile.

The upstream contracts are documented in ProFTPD's
[nonroot guide](https://github.com/proftpd/www.proftpd.org/blob/master/docs/howto/Nonroot.html),
[directory limits guide](https://github.com/proftpd/proftpd/blob/master/doc/howto/Limit.html),
[MLSx module](https://github.com/proftpd/proftpd/blob/master/doc/modules/mod_facts.html) and
[TLS module](https://github.com/proftpd/proftpd/blob/master/doc/contrib/mod_tls.html). Readiness uses the native
`standalone mode STARTUP` marker, emitted after listener initialization in
[the server source](https://github.com/proftpd/proftpd/blob/master/src/main.c).
