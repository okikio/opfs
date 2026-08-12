@utils/csv public API usage
===========================

Purpose
-------

This reference maps every public export target declared by `@utils/csv` to its role and to a concrete repository use when one exists.

The package README teaches the programming model progressively.  This file is the exhaustive lookup surface for developers who already know the model.

@utils/csv
----------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `classifyCsvHeader` | function | Classifies a header only when it matches an explicit default alias. | `classifyCsvHeader(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `createCsvHeaderClassifier` | function | Builds a reusable classifier by extending, rather than replacing, the default aliases. | `createCsvHeaderClassifier(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CsvColumn` | interface | One normalized source column. | `value: CsvColumn` | `apps/frontend/src/routes/(product)/_app/(import)/-components/ImportComposer.tsx:459` uses `CsvColumn`. |
| `CsvColumnRole` | type | Semantic roles used only for domain-oriented column mapping. | `value: CsvColumnRole` | `apps/frontend/src/routes/(product)/_app/(import)/-capability-repository.client.ts:69` uses `CsvColumnRole`. |
| `CsvDelimiter` | type | Delimiters supported by the CRM CSV parser. | `value: CsvDelimiter` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CsvDiagnostic` | interface | Recoverable parser observation suitable for an import preview. | `value: CsvDiagnostic` | `apps/frontend/src/routes/(product)/_app/(import)/-types.ts:13` uses `CsvDiagnostic`. |
| `CsvDiagnosticCode` | type | Supported warning codes emitted for recoverable input conditions. | `value: CsvDiagnosticCode` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CsvDocument` | interface | Structurally parsed CSV document before domain extraction. | `value: CsvDocument` | `apps/frontend/src/routes/(product)/_app/(import)/-components/ImportComposer.tsx:95` uses `CsvDocument`. |
| `CsvEncoding` | type | Byte decoding selected for the source file. | `value: CsvEncoding` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CsvHeaderAliases` | type | Complete alias lists used to classify source headers. | `value: CsvHeaderAliases` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CsvHeaderAliasOverrides` | type | Additional aliases merged with the package defaults for one parse operation. | `value: CsvHeaderAliasOverrides` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CsvLineEnding` | type | Line-ending style observed after decoding. | `value: CsvLineEnding` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CsvParseError` | class | Stable unrecoverable parse error. | `new CsvParseError(...)` | `apps/frontend/src/routes/(product)/_app/(import)/-components/ImportComposer.tsx:574` uses `CsvParseError`. |
| `CsvRow` | interface | One logical data row after the selected header. | `value: CsvRow` | `apps/frontend/src/routes/(product)/_app/(import)/-types.ts:12` uses `CsvRow`. |
| `CsvStreamDocument` | interface | One-shot, backpressure-aware CSV document. | `value: CsvStreamDocument` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CsvStreamMetadata` | interface | Metadata resolved before streamed data rows are consumed. | `value: CsvStreamMetadata` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `DEFAULT_CSV_HEADER_ALIASES` | value | Default domain-oriented aliases derived from the supplied CRM fixture pack. | `DEFAULT_CSV_HEADER_ALIASES` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `normalizeCsvHeader` | function | Normalizes a source header for stable alias matching and generated keys. | `normalizeCsvHeader(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `parseCsv` | function | Parses decoded CSV text without coercing identifiers, dates, numbers, or formulas. | `parseCsv(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `parseCsvBytes` | function | Parses original CSV bytes with strict UTF-8 detection and bounded structural limits. | `parseCsvBytes(...)` | `apps/frontend/src/routes/(product)/_app/(import)/-components/ImportComposer.tsx:280` uses `parseCsvBytes`. |
| `ParseCsvOptions` | interface | Caller-controlled parser behavior and safety limits. | `value: ParseCsvOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `parseCsvStream` | function | Parse a byte stream into one owned, one-shot, backpressure-aware CSV stream. | `parseCsvStream(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ParseCsvStreamOptions` | interface | Streaming parser behavior and bounded discovery limits. | `value: ParseCsvStreamOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |

Detected uses
~~~~~~~~~~~~~

`parseCsvBytes` appears in `apps/frontend/src/routes/(product)/_app/(import)/-components/ImportComposer.tsx:280`:

~~~~ typescript
const document = await parseCsvBytes(new Uint8Array(await entry.file.arrayBuffer()), {
				fileName: entry.file.name,
				maxBytes: MAX_CSV_BYTES,
			})
~~~~

`CsvParseError` appears in `apps/frontend/src/routes/(product)/_app/(import)/-components/ImportComposer.tsx:574`:

~~~~ typescript
if (cause instanceof CsvParseError) return cause.message
	return readError(cause, 'The selected source could not be parsed.')
}
~~~~

`CsvColumn` appears in `apps/frontend/src/routes/(product)/_app/(import)/-components/ImportComposer.tsx:459`:

~~~~ typescript
const selected = [accountIdColumn(), resolutionColumn()].filter((column): column is CsvColumn => Boolean(column))
		const initial = document().columns.slice(0, PREVIEW_COLUMN_COUNT)
		for (const column of selected) {
			if (!initial.some((candidate) => candidate.key === column.key)) {
~~~~

`CsvColumnRole` appears in `apps/frontend/src/routes/(product)/_app/(import)/-capability-repository.client.ts:69`:

~~~~ typescript
function normalizeResolution(value: string, role: CsvColumnRole): string {
	const trimmed = value.trim()
	if (!trimmed) return ''
	if (role === 'email') return trimmed.toLowerCase().split('@').at(-1) ?? ''
~~~~

`CsvDiagnostic` appears in `apps/frontend/src/routes/(product)/_app/(import)/-types.ts:13`:

~~~~ typescript
diagnostics: readonly CsvDiagnostic[]
	delimiter: string
	accountIdColumnKey: string | null
	resolutionColumnKey: string | null
~~~~

`CsvDocument` appears in `apps/frontend/src/routes/(product)/_app/(import)/-components/ImportComposer.tsx:95`:

~~~~ typescript
document?: CsvDocument
	accountIdColumnKey: string | null
	resolutionColumnKey: string | null
	error?: string
~~~~

`CsvRow` appears in `apps/frontend/src/routes/(product)/_app/(import)/-types.ts:12`:

~~~~ typescript
rows: readonly CsvRow[]
	diagnostics: readonly CsvDiagnostic[]
	delimiter: string
	accountIdColumnKey: string | null
~~~~

@utils/csv/dialect
------------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `rankCsvDelimiters` | function | Ranks supported delimiters using a quote-aware bounded source sample. | `rankCsvDelimiters(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |

@utils/csv/encoding
-------------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `decodeCsvBytes` | function | Decodes original bytes while preserving whether a legacy fallback was required. | `decodeCsvBytes(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `decodeCsvText` | function | Wraps caller-decoded text in the same source contract as byte input. | `decodeCsvText(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `DecodedCsvSource` | interface | Decoded source plus metadata required by the structural parser. | `value: DecodedCsvSource` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |

@utils/csv/headers
------------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `classifyCsvHeader` | function | Classifies a header only when it matches an explicit default alias. | `classifyCsvHeader(...)` | `.agents/tests/public-api-matrix.test.ts:336` uses `classifyCsvHeader`. |
| `createCsvHeaderClassifier` | function | Builds a reusable classifier by extending, rather than replacing, the default aliases. | `createCsvHeaderClassifier(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `DEFAULT_CSV_HEADER_ALIASES` | value | Default domain-oriented aliases derived from the supplied CRM fixture pack. | `DEFAULT_CSV_HEADER_ALIASES` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `normalizeCsvHeader` | function | Normalizes a source header for stable alias matching and generated keys. | `normalizeCsvHeader(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |

Detected uses
~~~~~~~~~~~~~

`classifyCsvHeader` appears in `.agents/tests/public-api-matrix.test.ts:336`:

~~~~ typescript
assert.equal(classifyCsvHeader(index === 0 ? 'website_url' : 'company domain'), index === 0 ? 'website' : 'domain');
			const readable = streams.readable([1, 2, 3]);
			const values: number[] = [];
			for await (const value of streams.iterable(readable)) values.push(value);
~~~~

@utils/csv/parse
----------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `parseCsv` | function | Parses decoded CSV text without coercing identifiers, dates, numbers, or formulas. | `parseCsv(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `parseCsvBytes` | function | Parses original CSV bytes with strict UTF-8 detection and bounded structural limits. | `parseCsvBytes(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |

@utils/csv/stream
-----------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `parseCsvStream` | function | Parse a byte stream into one owned, one-shot, backpressure-aware CSV stream. | `parseCsvStream(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |

@utils/csv/types
----------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `CsvColumn` | interface | One normalized source column. | `value: CsvColumn` | `utils/email/extract.ts:68` uses `CsvColumn`. |
| `CsvColumnRole` | type | Semantic roles used only for domain-oriented column mapping. | `value: CsvColumnRole` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CsvDelimiter` | type | Delimiters supported by the CRM CSV parser. | `value: CsvDelimiter` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CsvDiagnostic` | interface | Recoverable parser observation suitable for an import preview. | `value: CsvDiagnostic` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CsvDiagnosticCode` | type | Supported warning codes emitted for recoverable input conditions. | `value: CsvDiagnosticCode` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CsvDocument` | interface | Structurally parsed CSV document before domain extraction. | `value: CsvDocument` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CsvEncoding` | type | Byte decoding selected for the source file. | `value: CsvEncoding` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CsvHeaderAliases` | type | Complete alias lists used to classify source headers. | `value: CsvHeaderAliases` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CsvHeaderAliasOverrides` | type | Additional aliases merged with the package defaults for one parse operation. | `value: CsvHeaderAliasOverrides` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CsvLineEnding` | type | Line-ending style observed after decoding. | `value: CsvLineEnding` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CsvParseError` | class | Stable unrecoverable parse error. | `new CsvParseError(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CsvParseErrorCode` | type | Stable machine-readable parse failure codes. | `value: CsvParseErrorCode` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CsvRow` | interface | One logical data row after the selected header. | `value: CsvRow` | `utils/email/extract.ts:67` uses `CsvRow`. |
| `CsvStreamDocument` | interface | One-shot, backpressure-aware CSV document. | `value: CsvStreamDocument` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CsvStreamMetadata` | interface | Metadata resolved before streamed data rows are consumed. | `value: CsvStreamMetadata` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ParseCsvOptions` | interface | Caller-controlled parser behavior and safety limits. | `value: ParseCsvOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ParseCsvStreamOptions` | interface | Streaming parser behavior and bounded discovery limits. | `value: ParseCsvStreamOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |

Detected uses
~~~~~~~~~~~~~

`CsvColumn` appears in `utils/email/extract.ts:68`:

~~~~ typescript
columns: readonly CsvColumn[],
	classifier: EmailDomainClassifier = DEFAULT_EMAIL_DOMAIN_CLASSIFIER,
): AsyncGenerator<EmailRowDomain> {
	const companyColumn = columns.find((column) => column.role === 'company')
~~~~

`CsvRow` appears in `utils/email/extract.ts:67`:

~~~~ typescript
rows: AsyncIterable<CsvRow>,
	columns: readonly CsvColumn[],
	classifier: EmailDomainClassifier = DEFAULT_EMAIL_DOMAIN_CLASSIFIER,
): AsyncGenerator<EmailRowDomain> {
~~~~

Coverage note
-------------

This generated map contains 51 public names across 7 package export targets. 10 names have a direct in-repository use detected through TypeScript imports.

A missing in-repository use is not converted into a fake example. It is a signal that the export is currently an extension point, a type-level support surface, or an API that still needs a concrete adopter.

