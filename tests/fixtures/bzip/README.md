# Independent BZip2 producer and consumer receipt

`produce.py` never imports OPFS. It authors input bytes before alternating native bzip2 1.0.8 and Python `bz2`
producers. Native bzip2, Python `bz2` and 7zz 26.02 compare complete decoded payload bytes against those inputs. Python
and native bzip2 use libbzip2-family implementations, so they are not two independently authored algorithms; 7zz
supplies the separate native consumer. Tool versions and commands are retained verbatim in `independent.json`.

```sh
python3 tests/fixtures/bzip/produce.py --bzip /usr/bin/bzip2 --seven /opt/homebrew/bin/7zz
deno fmt tests/fixtures/bzip/independent.json
```

| Fixture        | Producer     | Original bytes | Packed bytes | Packed SHA-256                                                     |
| -------------- | ------------ | -------------: | -----------: | ------------------------------------------------------------------ |
| empty          | native-bzip2 |              0 |           14 | `d3dda84eb03b9738d118eb2be78e246106900493c0ae07819ad60815134a8058` |
| binary         | Python-bz2   |           1792 |          560 | `753f9f1bd6de71f52b0f5254042e02ad3e6596b43d02df30dc44a5c5867c450d` |
| multiblock     | native-bzip2 |         210000 |       212056 | `3a8fb075487bdef4207694c7b7c64e48a632818d0e4a883d8fb0e6b97cde5237` |
| long-run       | Python-bz2   |        2000000 |           50 | `138293b0e6286b6df776dcf5538cbe99d6ff7a2d5ced59c6e1ed824522e51954` |
| run-boundaries | native-bzip2 |          58048 |          223 | `ee85cbe1b65a8e334c6286de0fa4f10ef53a944e1afc177ebcf10d27f2631edd` |
| level-1        | Python-bz2   |            527 |           93 | `c000af2fcd2b6a7474de2f1ab2c0c94fbc3700817c084e2e047bf386510b8a5b` |
| level-2        | native-bzip2 |            527 |           93 | `5da6e8f9510ada1f6b8e728c0a56853032bbb67ae6726b7cf85472aa1bf36303` |
| level-3        | Python-bz2   |            527 |           93 | `b3f7913f8409463ddf3035315b12b40e2ab494d48aa59c16607498a3be8e6ea7` |
| level-4        | native-bzip2 |            527 |           93 | `c665b6f561f96af739811eace1245da144bebf99a1fbb3ba4ddc889a0f1cf4a8` |
| level-5        | Python-bz2   |            527 |           93 | `d485b645c11c66315f5f4bd7a2d96973392b741dae1a52793a59f03f1f3fc886` |
| level-6        | native-bzip2 |            527 |           93 | `1953c3a81b4f3735e188faac176f6b72ff98fec7db8ea5eb7e09dd17efec8416` |
| level-7        | Python-bz2   |            527 |           93 | `7b07ba213df4b3c86da69172404569151031baa47e82ce87f4a6dc485ddce78e` |
| level-8        | native-bzip2 |            527 |           93 | `3b3569393ae2ecd2981b07230c29cae9fa032a37776a8441648e4c4ff3d68dca` |
| level-9        | Python-bz2   |            527 |           93 | `40c03463a63f7788ede21c814e628f87763090eacf80ee3463882976703e621a` |

The `nonzero-padding` diagnostic changes only five unused final bits. Native bzip2 and Python accept the full payload;
7zz returns the complete payload but exits2 with a data error. That negative receipt is retained unchanged. The
candidate selects a strict zero-padding profile and does not treat this discrepancy as universal rejection by all
decoders. Legacy randomized support remains refused; changing a randomization flag is an admission regression, not a
genuine legacy randomized producer fixture.

Format research used the official [bzip2 1.0.8 release](https://sourceware.org/pub/bzip2/bzip2-1.0.8.tar.gz), 810,029
bytes, SHA-256 `ab5a03176ee106d3f0fa90e381da478ddae405918153cca248e682cd0c4a2269`. This hash records acquired bytes. It
does not claim independent PGP signature verification. The official GitLab `bzip2-1.0.8` tag reports commit prefix
`6a8690fc`; the full commit page was unavailable, so the acquired release bytes are the immutable research authority.
Files inspected from that archive:

| Source file       | SHA-256                                                            |
| ----------------- | ------------------------------------------------------------------ |
| `decompress.c`    | `31a89f8bf408ef0e4acae83e8be60a8eb4edece6c866d6e32b8f7e557ca54bc6` |
| `bzlib.c`         | `d06cf1bd991df1f2dc8ef4f7713d186eb636767111cbd4807ef5fc4a54ca6838` |
| `bzlib_private.h` | `c0cda4f35ee1f2d54c9beacd524f8d28e0dbf8494aca30d854af3f143af4341b` |
| `huffman.c`       | `bdeb45f3f535546a672811b68aa87cc58fd395b28ecebc34fa3566a656a4d1d1` |
| `crctable.c`      | `2fb7a564629386456e731f431a5cf4f5026747bace4cd10be8f5ecf082066a92` |
| `LICENSE`         | `c6dbbf828498be844a89eaa3b84adbab3199e342eb5cb2ed2f0d4ba7ec0f38a3` |
| `manual.xml`      | `f333eb33556218995a79870a1d2c01a06bdaa9994549142cfbeb0c8b96425234` |

Fixture files after repository formatting:

- `produce.py`: SHA-256 `8b0b444e171d3c42024f3d27e8c9bf121f1228b4efa022fe6fb102088c48fbb1`.
- `independent.json`: SHA-256 `bbd802e7f8b091333def46ab44188f11ef74d3dc568e623fafa31acaebf83dac`.

Original expected bytes are retained in full; they do not come from candidate output. Research sources and native tools
are not production dependencies. No upstream source implementation is copied into the decoder.
