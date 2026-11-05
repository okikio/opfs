# Preview messages in an LF-native mailbox

Choose the dialect from the program that wrote the mailbox. This reader supports a narrow LF-only `mboxo` or `mboxrd`
profile; it cannot detect a dialect safely. Open one selected message as a byte source, then compose it with the MIME
reader to inspect attachments without materializing the mailbox or the whole message.

```ts
import { createBlobSource } from "@okikio/opfs/source";
import { openMbox } from "@okikio/opfs/archive/mbox";
import { openMime } from "@okikio/opfs/archive/mime";

export async function previewAttachment(mailbox: Blob) {
  const box = await openMbox(createBlobSource(mailbox), { dialect: "mboxrd" });
  // This producer is known to append exactly one mailbox-owned blank line.
  const message = await box.openMessage(0, { trailing: "remove-one" });
  const mime = await openMime(message.source);
  const attachment = mime.entries.find((entry) => entry.filename !== undefined);
  if (!attachment) return undefined;
  return { filename: attachment.filename, preview: await mime.prefix(attachment.id, 4096) };
}
```

The example assumes a known `mboxrd` producer. Selecting the wrong dialect can produce the wrong message boundaries or
quote bytes. `mboxcl`, `mboxcl2`, mixed mailboxes, CRLF-native mailboxes and the RFC 4155 canonical default format are
separate profiles and remain unsupported. No API detects or certifies the producer declaration.

## Stored bytes and preview bytes

`openMbox` scans every stored byte and returns frozen ordinal entries. Message-ID and Subject are not index keys. Each
entry retains an ASCII envelope line, its offset, and the following physical message extent. Every line beginning `From`
followed by a space is a separator in these profiles, whether or not it follows an empty line. The strict profile
requires a terminal empty line before the next separator and at EOF. Empty mailboxes are allowed. Envelope text is
untrusted metadata; its date, timezone and sender are not interpreted. `Content-Length` never controls framing.

`readRaw(id, {offset, length})` returns exact stored message-region bytes, including every trailing blank line. It
excludes the envelope line. `openMessage` requires a trailing-line policy: `preserve` keeps everything, whereas
`remove-one` drops exactly one final LF from the already validated terminal empty line. No trim operation removes
additional message content. A producer may have added or rewritten final newlines before storage, so neither choice
proves recovery of the original message.

The returned `source` has a known size and exact logical range reads. A bounded selected-message scan builds a range
map; reads then copy physical spans and insert CR before every stored LF. For `mboxrd`, exactly one leading `>` is
removed from lines matching `^>+From\x20`. For `mboxo`, all quotes remain: a stored `>From` followed by a space may have
been original or added by the writer, and the distinction is irrecoverable. The `transformation` result records the
quote and trailing policies. All results have integrity `none`; CRLF conversion is for MIME inspection and is never a
signature or original-wire-byte claim. MIME signing/encryption declarations remain unverified as described in
[MIME](mime.md).

## Work, limits and ownership

Sources are borrowed. Size, read method, identity and stability are captured when opening the mailbox. An immutable,
provider or caller stability assertion is required unless `allowUnverifiedSource` is explicit; an identifier alone is
not evidence. Converted sources preserve the stability evidence and derive an identity that records the conversion.
Unverified sources remain unverified. Cancellation reaches the borrowed source; nothing closes caller resources.

Opening scans all mailbox bytes once. Opening a message scans its selected extent again, retaining only a range map.
Subsequent logical reads copy only required stored extents, in bounded chunks. The APIs are buffered range previews, not
public streaming iterators. Very large messages with many newlines can exceed the map limit even for a small preview;
this is an explicit implementation limit rather than hidden whole-message buffering.

| Policy                            | Default                                       |
| --------------------------------- | --------------------------------------------- |
| Physical chunk bytes              | 4096; admitted range 1..65536                 |
| Messages                          | 10000                                         |
| Envelope bytes, excluding LF      | 4096                                          |
| Mailbox metadata accounting       | 4 MiB; envelope bytes plus 64 bytes per entry |
| Selected-message range-map pieces | 100000                                        |
| Range-map metadata accounting     | 4 MiB; 32 bytes per piece                     |

Metadata accounting bounds retained records and string bytes; it is not an exact JavaScript heap measurement.
`maxSourceBytes`, `maxRequests`, `maxDecodedBytes`, `maxOutputBytes` and an optional shared `ledger` use the archive
[work contract](archive.md). `box.work` describes the mailbox scan. `message.inspect()` describes its selected scan and
cumulative range reads: limits supplied to `openMessage` do not reset for each read. Only bytes returned by logical
range reads count as decoded/output; map scanning counts physical source work. Shared ledgers can combine these with
MIME reads, but wrappers can count the same logical bytes at multiple layers; they do not reveal hidden provider
transport costs.

An `unsupported-profile` failure means the declared profile or source stability is outside this reader's contract;
identify the actual producer rather than trying dialects until one succeeds. `invalid-archive` reports framing that
violates the selected strict profile. Keep the original file for a producer-specific reader instead of rewriting it
silently. `budget-exceeded` reports a configured work or metadata limit; raise the relevant policy only when the caller
can afford the resulting scan or retained map. Source and cancellation failures retain their own errors.

## Evidence and format sources

The retained fixture uses CPython `mailbox.mbox` as a genuine mboxo producer and independent stored-byte consumer. The
mboxrd corpus uses an authored encoder and an independent Git `mailsplit --mboxrd` consumer. Git retains the terminal
mailbox blank line; Python `get_bytes` removes one. Tests cover both policies explicitly, quote depth, small source
chunks, transformed range cuts and mailbox-to-MIME attachment bytes. This is producer/consumer contract evidence, not
compatibility proof for every mail client. Fixture versions, hashes and reproduction instructions are in
[the fixture record](../tests/fixtures/mbox/README.md).

[RFC 4155](https://www.rfc-editor.org/rfc/rfc4155.html) explains why mailbox variants must be distinguished; this reader
does not claim its canonical-default compliance. The
[qmail format description](https://manpages.debian.org/testing/qmail/mbox.5qmail.en.html) defines mboxrd quoting and
distinguishes mboxo/cl/cl2. [Python mailbox](https://docs.python.org/3/library/mailbox.html) documents mboxo's
irreversible quotes, and [Git mailsplit](https://git-scm.com/docs/git-mailsplit) documents its explicit mboxrd unquoting
option. No renderer, external resource fetch, HTML execution, mailbox writes or authentication is part of this reader.
