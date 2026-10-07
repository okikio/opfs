# Large test fixtures

Fixtures up to 256 KiB live in Git beside the tests that read them. A larger fixture is a download: Git tracks its path,
size and SHA-256 in `tests/fixtures/store.json`, and the bytes are an asset of this repository's `fixtures` GitHub
release, named by that SHA-256. Keeping them out of Git keeps clones and CI checkouts small, while the hash still pins
exactly which bytes a test reads.

`mise run prepare:fixtures` puts every stored fixture back in place before tests run. It downloads into
`.tmp/fixtures/<sha256>`, checks the size and hash, and only then copies the file to its path, so an interrupted
download never leaves a truncated fixture behind. Test and type-check tasks depend on it, so you rarely run it by hand.
`tests/fixtures/.gitignore` is generated from the manifest and keeps the restored copies untracked.

## Add or change a large fixture

1. Commit the fixture normally on your branch and push it. Note that commit's SHA.
2. Run `mise run build:fixtures`. It moves every tracked fixture over the limit into the manifest, untracks it and
   regenerates the ignore list. Commit and push the result.
3. Dispatch the **Fixtures** workflow with `ref` set to your branch and `source` set to the commit from step 1. It
   uploads every manifest entry that the release does not have yet, after checking its hash.

A changed fixture is a new hash and a new asset; existing assets are never replaced or deleted, because older commits
still reference them. `mise run check:fixtures` fails when a tracked fixture is over the limit or the manifest and its
ignore list disagree. It reads no network; a missing asset fails `prepare:fixtures` instead, with the fixture's path.
