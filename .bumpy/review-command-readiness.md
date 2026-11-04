---
"@okikio/opfs": patch
---

Native cancellation controls now publish their readiness record only after its byte has been written and the file has
closed. A final-path `writeFileSync()` first creates a file and then writes it. On Windows, the waiting parent observed
that empty file between those steps and correctly rejected its bytes. The test had mistaken file creation for completed
publication.

The child now writes an exclusive private stage and renames it to the final marker within the same fixture directory:

```text
empty private stage -> parent proves final marker absent -> approval directory
                    -> write byte -> close stage -> rename to ready.bin -> cancel child
```

The control deliberately holds the stage empty until the parent approves publication, so an ordinary fast write cannot
hide this case. After publication, the parent still requires the exact marker byte and the stage's absence. It then
cancels the actual running child and checks the admitted stdout bytes, original cancellation reason, native exit and
pipe close. The single finite readiness budget includes both phases; no elapsed-time assertion or additional retry can
turn malformed published bytes into success.

This is a fixture publication repair. Same-directory rename supplies a visibility boundary for the cooperating native
fixture; it does not establish durable storage after a power loss or a security boundary against hostile writers.
Library validation and native command capture contracts are unchanged.
