# Mailbox producer and consumer evidence

The historical `produce.py.snapshot` used trusted authored messages, a temporary directory, Python standard-library
`mailbox.mbox`, and the installed Git executable. Nothing in this fixture is a production dependency. The retained JSON
records runtime versions and SHA-256 hashes of both mailboxes.

Recorded producer: CPython 3.9.6 `mailbox.mbox` (mboxo). Its `get_bytes` output is the independent stored-byte oracle:
it preserves stored quotes and excludes exactly one mailbox terminal LF. Both original body quotes and escaped From
lines occur in the authored messages; mboxo cannot distinguish them on read.

The mboxrd encoder in `produce.py.snapshot` is authored test code, not independent producer evidence. The independent
consumer is Git 2.54.0 (Apple Git-157), `git mailsplit --mboxrd`. Its retained output removes one quote from every
`^>+From` line and preserves the mailbox terminal blank line. Original messages provide separate authored byte oracles
for the explicit remove-one preview policy. Git output includes the envelope; the test explicitly excludes its first
line and normalizes LF to CRLF for preview comparison.

The second message contains the authored attachment bytes `[0,1,2,3,255]`; selected MIME decoding checks those exact
bytes. Duplicate Message-ID values demonstrate why physical ordinals, not header values, identify entries. All fixture
messages and generator code are original project-authored material; no third-party mail content is redistributed.

## Current TypeScript controls

Run from the repository root, choosing a new receipt path:

```sh
node --max-old-space-size=128 tests/fixtures/mbox/produce.ts --git git --output /tmp/new-mbox-controls.json
```

`produce.ts` imports no candidate OPFS code and acquires no packages. It authors fixed wire/file controls from the
original payloads and compares those complete originals with the retained historical fixture. Git `mailsplit --mboxrd`
must independently restore every message byte, including the envelope and terminal newline. Each of the two native
commands has a 15-second deadline and a 1 MiB pipe quota. A failed spawn, signal or nonzero status fails the run. The
new mboxo encoding remains authored evidence; no new Python mailbox validation is claimed.

The producer accepts only the fixed authored case set, admits at most 1 MiB of historical JSON and refuses a receipt
over 1 MiB. The command above places a 128 MiB V8 heap limit around the run; native memory and whole-process limits
remain the outer runner's responsibility. It uses exclusive creation and refuses to overwrite an existing output. A
fresh temporary mailbox directory has one owner; both the primary failure and cleanup failure are retained if they occur
together. Keep new receipts separate from `independent.json`, which still supplies the existing tests' historical
independent proof. `source-map.json` records the old source bytes and SHA-256 without relabelling old receipts as
TypeScript executions. The new source does not promise the historical wire hashes or broader format conformance.
