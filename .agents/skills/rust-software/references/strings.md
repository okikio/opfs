# Keep bytes, text, and operating-system strings distinct

Use this for parsing, extraction, identifiers, filenames, FFI, or large text.
Choose the representation from the data contract before optimizing it.

| Meaning | Ordinary Rust representation | Invariant |
| --- | --- | --- |
| Arbitrary or unvalidated data | `&[u8]`, `Vec<u8>` | Encoding is not assumed |
| Valid UTF-8 text | `&str`, `String` | Every exposed string is valid UTF-8 |
| Optional transformation | `Cow<'a, str>` | Borrow until a change requires ownership |
| Source location | Checked byte range plus source owner | Range survives only with the source/version |
| OS path/name | `Path`, `PathBuf`, `OsStr`, `OsString` | Preserve platform representation |
| C text | Pointer/length or documented `CStr`/`CString` wrapper | Encoding and NUL rules are explicit |

## Avoid copies by preserving useful ownership

Accept `&str` rather than `&String` when only text is needed. Return slices or
spans when the caller can keep the source alive. When ownership is required,
move the existing `String`/`Vec` instead of cloning it. Reuse a caller-owned
output buffer only if its mutation and error semantics stay clear.

Do not convert bytes to owned strings just to search ASCII delimiters. Byte
search can operate on the original slice, then validation can establish the
text region. Avoid repeated `to_string`, formatting, lossy decoding, and
case-conversion inside hot loops unless the operation requires them.

Intern only when repeated values and a defined interner lifetime justify its
lookup and retention costs. Deduplicating a few small strings can cost more
than storing them. A global interner can retain unbounded untrusted input.

## Preserve text semantics at every split

Byte offsets, Unicode scalar values, grapheme clusters, and display columns
are different units. Use byte offsets for parser spans and explicitly choose
the right unit for user-facing editing/counts. A byte range into `str` must
start and end on valid character boundaries; use checked slicing for input-
derived ranges. Normalization and case folding are product decisions, not
automatic cleanup that can alter identifiers or extracted evidence.

When decoding a stream, a chunk can end inside one UTF-8 scalar value.
`Utf8Error::error_len() == None` identifies an incomplete suffix; retain it
for the next chunk and reject or handle it explicitly at final EOF. Decoding
each chunk lossily can permanently replace valid split text. Preserve original
bytes and error offsets when incorrect text matters to customers.

The local native and WASI probes reproduced this corruption with a split
four-byte character. Their successful recombination demonstrates the required
invariant; it is not a complete streaming decoder implementation.

## Keep platform encoding out of portable protocols

Do not serialize `OsStr::as_encoded_bytes` as a cross-platform format. Its
encoding is unspecified and scoped to the Rust version/target. Define a real
wire format and conversion/error behavior. On Windows, use the owning OS API's
documented encoding rather than assuming paths are UTF-8 or using lossy text
as an identity. C# and JavaScript string conversions can also allocate.

## Sources

- [UTF-8 stream error information](https://doc.rust-lang.org/std/str/struct.Utf8Error.html)
- [String-slice invariant](https://doc.rust-lang.org/std/primitive.str.html)
- [OS string encoding](https://doc.rust-lang.org/std/ffi/struct.OsStr.html)
