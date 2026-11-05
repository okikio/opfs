# Native Git loose-object fixtures

These inert binary files were produced by `git version 2.54.0 (Apple Git-157)` in fresh temporary repositories using
`git init --object-format=sha1` and `git init --object-format=sha256`. No OPFS implementation produced these bytes.
`manifest.json` records object IDs, exact payload lengths, native tree entry names as hex, and SHA-256 hashes of every
binary oracle.

For each repository the producer ran:

1. `git hash-object -w --stdin` for binary bytes `00 62 69 6e 61 72 79 ff 0a 62 79 74 65 73 00`, empty bytes, and
   `../target`.
2. `git mktree -z` with empty input for the empty tree, then `git commit-tree` for that tree with `Fixture commit\n`,
   author/committer `Fixture <fixture@example.invalid>`, and both dates `2000-01-01T00:00:00Z`.
3. `git mktree -z` for entries in the manifest. The input used native mode/type, full object ID, TAB, exact binary name,
   NUL records. Names include invalid UTF-8, newline, backslash, UTF-8 café, and `a.c` beside directory `a`.
4. `git cat-file <type> <oid>` to save each complete `.raw` payload and `git ls-tree -z <oid>` for the root tree oracle.
   The corresponding compressed `.git/objects/<first-two>/<rest>` files were copied as `.loose` files.
5. `git mktag` for the empty tree with tag name `fixture`, tagger `Fixture <fixture@example.invalid> 946684800 +0000`,
   and message `Fixture tag\n`. `git cat-file tag <oid>` supplies the opaque tag payload oracle.

The tests verify the recorded binary hashes, compare complete decoded payloads, and compare the independently encoded
tree with `cat-file` bytes. References include a genuine full-width commit gitlink in both repository formats. They do
not invoke Git or modify a repository during tests. The raw names must not be rendered as trusted text or extracted into
paths.

Primary contract revision is Git v2.54.0 resolved commit `94f057755b7941b321fd11fec1b2e3ca5313a4e0`:

- [gitformat-loose.adoc](https://github.com/git/git/blob/94f057755b7941b321fd11fec1b2e3ca5313a4e0/Documentation/gitformat-loose.adoc),
  exact raw source SHA-256 `adcc1b8c22b5a60881e75876e9f7ab5b3a128b62c1903bfc960bce0c746ebc52`.
- [tree-walk.c](https://github.com/git/git/blob/94f057755b7941b321fd11fec1b2e3ca5313a4e0/tree-walk.c), exact raw source
  SHA-256 `8f4b3f8e73665470077982b5ed3a2e519aec0db1e9d348b96e1fc67426819cd8`.
- [Hash function transition](https://github.com/git/git/blob/94f057755b7941b321fd11fec1b2e3ca5313a4e0/Documentation/technical/hash-function-transition.adoc)
  explains repository-scoped reference widths and SHA1DC, which native WebCrypto SHA-1 does not reproduce.
