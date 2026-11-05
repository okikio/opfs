# Independent EML/MIME fixture

`independent.json` retains bytes produced by CPython 3.9.6's standard-library `email.message.EmailMessage`, serialized
with `email.policy.SMTP`, and consumed by `email.parser.BytesParser`. `produce.py` fixes boundaries, headers and
authored payloads, asserts the parser reports no defects, and checks exact authored plain-text and binary attachment
bytes. The fixture contains mixed/alternative nesting, quoted-printable UTF-8 text, Base64 HTML, a Base64 binary
attachment with an RFC 2231 filename, preamble and epilogue. No candidate OPFS parser participates in its expected
results.

The producer and parser belong to [CPython](https://github.com/python/cpython/tree/v3.9.6/Lib/email), distributed under
[PSF License 2.0](https://docs.python.org/3/license.html). No upstream executable source is copied. The fixture's
original message and reproduction script are authored for this repository; no real person's mail or credentials are
included.

Reproduce from the repository root with CPython 3.9.6:

```sh
python3 tests/fixtures/mime/produce.py
```

Other CPython versions may format/fold headers differently. Keep the checked-in immutable byte fixture when comparing
behavior, rather than silently replacing its bytes with a new version's output. The SHA-256 of decoded EML bytes is
`b31d240280c9c9346c0cbb96a1723a7731e3232a4c04d4a1bc7a81800bc29c1b`; the runtime tests verify it before reading records.
The ordinary TypeScript tests consume saved JSON and do not run Python or fetch dependencies.

Authored malformed/ambiguous inputs are separate tests, not independent producer fixtures. Cross-chunk comparisons are
invariance tests, while the Python payload/filename/tree oracles establish behavior on these fixed messages. This is not
proof of complete MIME conformance or MBOX interoperability. Python's mailbox module uses mboxo; no mboxrd producer
claim is made here.
