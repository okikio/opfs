# Compact JWE evidence

`rfc7520.json` retains the independent published compact JWE in RFC 7520 section 5.6. Figure 130 supplies the direct AES
key and Figure 136 supplies the complete wire serialization. Only display whitespace is removed between its wrapped
lines. Figure 72 supplies the complete original UTF-8 plaintext. The fixture records its byte length and SHA-256 instead
of copying that prose quotation. The test authenticates and hashes every resulting byte, not a selected prefix.

`primary-receipts.json` records exact text-document byte counts and SHA-256 receipts for RFCs 7516, 7518, 7520 and 8725.
Numbered RFC URLs identify immutable specification editions. The original complete text documents remain local research
inputs rather than package fixtures. `LICENSE.rfc.txt` retains the IETF Trust code-component notice. The fixture's
opaque key and ciphertext are published test material, never production credentials.

The published vector is an independently authored wire oracle; the candidate did not produce its expected ciphertext,
length or digest. Authored test envelopes use WebCrypto directly and therefore provide additional grammar, lifecycle and
composition checks, not an independent AES implementation. The exact jose 6.2.15 npm artifact has now been acquired and
inspected as inert bytes. `acquisition.json` and `inspection.json` retain its extents, SHA-512/SHA-256, member hashes,
package/license and static literal import observations. Original source files remain `.snapshot` bytes and are never
formatted or installed.

The first offline native producer passed all eight complete original-byte comparisons: empty, binary, decomposed Unicode
and independent Python ZIP under both AES key sizes. `independent.json.snapshot` retains the unformatted original
output. `native-receipt.json` records its SHA, all inputs, actual Node 26.13.0, exact image and resource state.
`produce.mjs` reconstructs only SHA-admitted snapshot paths in a fresh `/tool/sdk`, then imports that absolute SDK
entrypoint. `producer-run.py` owns the bounded launcher. The candidate is never imported. Both SDK paths share native
WebCrypto AES; this is not independent cipher evidence.

The final focused matrix passes 35 cases on Deno 2.9.8, Node 26.13.0 and Bun 1.4.2, including every native original and
both selected ZIP previews. `focused-native-receipt.json` distinguishes this final matrix from the retained first
25-case lint finding. No upstream SDK bytes are executed by ordinary candidate tests; only the independent output JSON
is imported.

`benchmark.json.gz` preserves all six raw Mitata distributions with verified lossless SHA-256 readback. `benchmark.json`
supplies workload/runtime/resource/input receipts and actual external CPU activity. The measured cold and warm
operations are different contracts, not an SDK speed comparison. All 49 retained upstream snapshots still match their
admitted original hashes after formatting candidate-owned files.
