`@utils/csv`
============

Purpose
-------

`@utils/csv` parses bounded CSV input without assuming a database, browser UI,
or import workflow. It owns CSV structure, encoding and delimiter discovery,
streaming rows, and parse diagnostics.

How it fits
-----------

Higher-level import code can classify columns, deduplicate rows, persist data,
or extract company evidence after this package produces structured CSV rows.
The parser stays reusable in browsers, Deno, Node, Workers, and edge runtimes.

Runtime-neutral CSV structure utilities using Web Streams and `@std/csv`.

```text
ReadableStream<Uint8Array>
        |
        | bounded peek, never whole-file buffering
        v
encoding + delimiter discovery
        |
        v
CsvParseStream: quoted fields and embedded newlines
        |
        v
bounded header scan
        |
        v
owned AsyncIterable<CsvRow> with consumer-controlled backpressure
```

`parseCsvStream` is the primary API for unknown or large inputs. The returned
`CsvStreamDocument` is a one-shot `AsyncDisposable`; consume its rows or dispose
it so the source reader and parser are cancelled deterministically.

Every source dimension is bounded independently: bytes, header discovery,
columns, rows, and cell length. Recoverable row observations are attached both
to their exact `CsvRow` and to the collected document diagnostic inventory.

`parseCsv` and `parseCsvBytes` are explicit collecting conveniences for
previews, fixtures, and small trusted sources. They preserve the same row and
diagnostic contracts but necessarily retain the complete document in memory.

The package does not classify email providers, extract company domains, persist
rows, or deduplicate an entire import. Those responsibilities compose at a
higher layer so this package remains useful in browsers, Deno, Node, workers,
and edge runtimes.

Progressive usage
-----------------

The package participates in the complete domain-enrichment example in
`docs/implementation/utils-progressive-usage.md`.  Read that guide when the
individual helpers make sense in isolation but their place in a service,
resource graph, runtime host, or workflow is not yet clear.

`API.md` is the exhaustive public-surface map for this package.  It lists every
package export target, explains each exported name, gives a compact use form,
and expands every detected repository use into a source-backed TypeScript
snippet.  An export with no current consumer stays labelled as unproven instead
of receiving an invented production example.

