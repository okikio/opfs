# Independent MSZIP vectors

The historical `mszip.py.snapshot` created authored CAB framing around Python zlib 1.2.12 streams, including explicit
prior-history dictionaries. It never imports OPFS. These vectors supplement the genuine gcab/cabextract corpus; they are
not extra genuine gcab producer outputs.

Current tooling is [`mszip.ts`](mszip.ts). In an isolated fixture environment, use Node 26.5 or later and a new output
path:

```sh
node tests/fixtures/cab/mszip.ts --seven /opt/homebrew/bin/7zz --output /tmp/new-mszip.json
```

The TypeScript source uses Node zlib and a documented xorshift32 original-byte pattern rather than CPython Random. It
has not produced the frozen results below and does not promise their archive hashes. The [fixture guide](README.md)
explains its full-byte comparisons, refusal controls and ownership. Existing `mszip.json` remains unchanged.

Complete authored inputs and packed blocks are retained. Python independently checks exact decoded bytes, EOF and
absence of unused compressed data. Each profile records whether dictionary-free raw decoding fails. Native 7zz 26.02
consumes four complete CAB payloads. It rejects the three-short-block diagnostic, whose stderr, output length and output
hash remain explicit negative evidence. Tests do not convert that failure into a native-interoperability claim.

| Profile         | Native result     | Payload bytes | CAB SHA-256                                                        |
| --------------- | ----------------- | ------------: | ------------------------------------------------------------------ |
| dynamic-history | pass, exact bytes |         54768 | `d16cea09a694419e7428da1209225f86a0250a61216e5f812c090600585cbffd` |
| fixed-history   | pass, exact bytes |         54768 | `72f52a4540c2786b6f26cfa44d152de7caef2870e8916d570618e96e3365b8f8` |
| stored          | pass, exact bytes |         32785 | `64671fd62659cc7fb8355785331b4ed5db7e358a0ef05b132a79b9978ef03c0d` |
| short-history   | retained exit 2   |          9144 | `e1df82c4b5580543a1e3f0cb03fe04033ef577e8c341f19f6b742588cb60d95f` |
| overlap         | pass, exact bytes |         65536 | `bc55dfd23b7926324784be59373c79700c3cc01abf75e1016c3f4fffcb35fe6a` |

Fixture hashes after repository formatting:

- `mszip.py.snapshot`: SHA-256 `ee86172dc66e731d1ee6add50ba40ac94c5d3422ee963872803cc02093f9224b`.
- `mszip.json`: SHA-256 `9a3bf55229c45549b9925825df6153c8c52069e2df91f11bc1a75b8572f3a0bb`.

The format authorities are
[MS-MCI section 2](https://learn.microsoft.com/en-us/openspecs/exchange_server_protocols/ms-mci/3048c471-f739-4d30-bcb3-a962cfe84a69)
and [RFC 1951](https://www.rfc-editor.org/rfc/rfc1951). Python and 7zz are test-only tools. No upstream implementation
source or production dependency is added. Existing genuine gcab/cabextract bytes and provenance remain unchanged.
