# Independent Glacier tree and signing fixtures

Maintainers can run `tests/glacier.test.ts` through the repository's normal test commands. It imports
`tests/glacier-oracle.ts`, which checks the candidate against frozen independent results. These are offline algorithm
and request-byte checks; they do not prove AWS account access, service acceptance, retrieval completion, or paid Glacier
operations.

The tests reconstruct each complete original from `originals.json`. Before using candidate code, they check the complete
reconstructed bytes against that frozen manifest's SHA-256. The independent generator `originals.mjs.snapshot` produced
the same 58,720,207 original bytes in a separate offline container. The resulting original manifest was then consumed by
the separate botocore and Smithy phases. The large binary originals remain in the ignored execution receipt directory
instead of this test fixture. This keeps the retained test material small without replacing original data with hashes
alone: every upload comparison checks every submitted byte against the verified deterministic original, as well as its
linear hash.

`glacier-trees.json` retains all 13 complete tree results, all ordered leaf hashes, and the 15 parts of three multipart
originals. Part sizes are 4 MiB, 2 MiB, and 2 MiB; their final parts are short, including a final three-leaf odd
subtree. Tests compare whole and leaf roots, each multipart extent and its tree root, all complete submitted bytes, and
each completion's whole-archive root. They do not apply the 1 MiB tree algorithm to a concatenation of 32-byte part
digests.

`signatures/` retains all 11 complete canonical requests, canonical headers, strings to sign, Authorization values, and
signed header records, unchanged. Six cases have exact public Glacier operations and are compared at the injected Fetch
boundary: `describe-empty`, `rotated-date-region-key`, `query-single-marker`, `upload-three-leaves`,
`upload-fixed-part`, and `complete-short-odd`. The expected headers retain Smithy's input whitespace; the comparison
applies Web `Headers` outer trimming to both sides, while the canonical preimage comparison checks AWS whitespace
folding. Golden text files remain unchanged and contain no added trailing newline.

Five retained controls have no matching public Glacier operation. They are explicit exclusions from candidate
compatibility claims:

| Original ID                 | Boundary                                                                                                                         |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `query-order-token`         | Repeated and empty arbitrary query parameters plus temporary credentials; the public operation accepts one marker and one limit. |
| `encoded-archive-id`        | Synthetic GET of an archive ID; public Glacier retrieval is a job operation, with no GET archive method.                         |
| `port-whitespace`           | Arbitrary metadata header injection; the public client intentionally has no arbitrary header option.                             |
| `service-separated-control` | S3 service-scope signing control, not a Glacier request.                                                                         |
| `s3-path-policy-control`    | S3 single-encoding control, not a Glacier request.                                                                               |

Their full expected bytes and hashes are retained and checked for preservation. That preservation check is not candidate
or native-service conformance. Existing authored Glacier tests separately cover escaped job IDs and endpoint prefixes.
No generic public signing API is introduced to expose internal mechanics.

## Independent sources and legal retention

The official botocore 1.40.0 annotated tag peels to commit `a3bbf61a0a3548c6bc7b68dd0a23bb6242a8e630`.
`botocore-utils.py.snapshot` is the unchanged full inert official source. `botocore-tree-functions.py.snapshot` is its
unchanged lines 1116–1163: `calculate_tree_hash` and `_in_pairs`, including their original comments and docstrings.
`botocore-extraction.json` records both identities, line selection, and the wrapper's standard-library bindings.
`botocore-acquisition.json` retains the exact immutable URLs and bounded acquisition receipts. The full Apache license
and upstream notice accompany those bytes in `botocore-LICENSE.txt` and `botocore-NOTICE.txt`. No complete
`botocore.utils` module or unadmitted transitive dependency was imported; `tree_oracle.py.snapshot` used only the
admitted function slice and Python standard-library bindings.

`signing.mjs.snapshot` used existing test-only public exports from `@smithy/signature-v4` 5.7.2 and `@smithy/core`
3.33.2. The selected installed closure also contains `@smithy/types` 4.17.2 and `tslib` 2.8.1.
`installed-provenance.json` retains every selected installed file identity, package metadata, lock integrity, and legal
identities. The script verifies those actual installed bytes before import. Lock integrity identifies the locked
registry package; no fresh registry tarball comparison is claimed. `legal/` and `legal-copies.json` retain the selected
unchanged licenses and copyright notice. The script uses explicit fake credentials, dates, region, service and request
values; it does not use a credential provider chain or network. The canonical path literals were checked against the
public signer by independently signing the complete string-to-sign through its public string signing overload, in
addition to signing the request.

The `.mjs.snapshot` files retain the exact executed JavaScript sources as inert provenance. `originals.ts` and
`signing.ts` are typed ports for future reviewed refreshes; they have not produced these historical expectations. To
prepare a new offline refresh, use `node originals.ts NEW_ORIGINAL_DIRECTORY`, then
`node tree.ts ORIGINAL_DIRECTORY NEW_TREE_JSON` to reproduce the tree structure with the authored TypeScript comparison,
followed by `node signing.ts ORIGINAL_DIRECTORY TREE_JSON NEW_OUTPUT_DIRECTORY`. `tree.ts` uses Node SHA-256 and imports
no candidate code. It does not rerun botocore or replace its frozen independent authority. A new independent refresh
must explicitly record which tree authority supplies `TREE_JSON`. Each original or signature output directory must be
new; the tree output is a new JSON file. These commands do not install packages or contact AWS. Their dependencies must
already match `installed-provenance.json`. Current tests read frozen results without running either command. Do not
execute the inert full source, auto-install a dependency closure, or rewrite expected values from candidate output. A
deliberate oracle refresh requires a separately reviewed, isolated independent run and newly retained receipts before
candidate comparison.

## Execution evidence and limits

`oracle-receipt.json` records the successful original generation, tree, and signing phases. Each phase ran serially in
its pinned existing image with network disabled, a 512 MiB memory/swap ceiling, one CPU, 128 PIDs, no host mount,
dropped capabilities, no-new-privileges, bounded output and a 60-second external watchdog. All three reported exit 0, no
OOM, and confirmed container removal. `oracle-source-identity.json` identifies that run's frozen inputs.
`source-review.json` describes the earlier source-only review; its pre-execution status is historical, not a claim that
the later independent run was unexecuted.

`retained.json` records the exact unchanged copied file lengths and SHA-256 values. The preservation test checks them,
including the raw upstream and legal bytes. Run the candidate comparisons with `deno task test:glacier`. Type, runtime,
installed-artifact and CI checks are separate from this retained independent run; its successful execution alone does
not establish their results.
