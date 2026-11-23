# Mailbox producer and consumer evidence

Run `python3 tests/fixtures/mbox/produce.py` from the repository root. The generator uses trusted authored messages, a
temporary directory, Python standard-library `mailbox.mbox`, and the installed Git executable. Nothing in this fixture
is a production dependency. The retained JSON records runtime versions and SHA-256 hashes of both mailboxes.

Recorded producer: CPython 3.9.6 `mailbox.mbox` (mboxo). Its `get_bytes` output is the independent stored-byte oracle:
it preserves stored quotes and excludes exactly one mailbox terminal LF. Both original body quotes and escaped From
lines occur in the authored messages; mboxo cannot distinguish them on read.

The mboxrd encoder in `produce.py` is authored test code, not independent producer evidence. The independent consumer is
Git 2.54.0 (Apple Git-157), `git mailsplit --mboxrd`. Its retained output removes one quote from every `^>+From` line
and preserves the mailbox terminal blank line. Original messages provide separate authored byte oracles for the explicit
remove-one preview policy. Git output includes the envelope; the test explicitly excludes its first line and normalizes
LF to CRLF for preview comparison.

The second message contains the authored attachment bytes `[0,1,2,3,255]`; selected MIME decoding checks those exact
bytes. Duplicate Message-ID values demonstrate why physical ordinals, not header values, identify entries. All fixture
messages and generator code are original project-authored material; no third-party mail content is redistributed.
