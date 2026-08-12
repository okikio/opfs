/** Delimiters supported by the CRM CSV parser. */
export type CsvDelimiter = ',' | ';' | '	'

/** Byte decoding selected for the source file. */
export type CsvEncoding = 'utf-8' | 'utf-8-bom' | 'windows-1252'

/** Line-ending style observed after decoding. */
export type CsvLineEnding = 'crlf' | 'lf' | 'cr' | 'mixed' | 'none'

/** Semantic roles used only for domain-oriented column mapping. */
export type CsvColumnRole = 'company' | 'domain' | 'email' | 'unknown' | 'website'

/** Supported warning codes emitted for recoverable input conditions. */
export type CsvDiagnosticCode =
	| 'blank-header'
	| 'duplicate-header'
	| 'header-only'
	| 'legacy-encoding'
	| 'preamble-skipped'
	| 'row-width-mismatch'
	| 'spreadsheet-formula'

/** Recoverable parser observation suitable for an import preview. */
export interface CsvDiagnostic {
	/** Stable machine-readable warning code. */
	code: CsvDiagnosticCode
	/** Human-readable explanation. */
	message: string
	/** One-based logical row when the warning belongs to a record. */
	row?: number
	/** One-based column when the warning belongs to a field. */
	column?: number
	/** Original header when one is available. */
	header?: string
}

/** Complete alias lists used to classify source headers. */
export type CsvHeaderAliases = Readonly<
	Record<Exclude<CsvColumnRole, 'unknown'>, readonly string[]>
>

/** Additional aliases merged with the package defaults for one parse operation. */
export type CsvHeaderAliasOverrides = Readonly<Partial<CsvHeaderAliases>>

/** One normalized source column. */
export interface CsvColumn {
	/** Zero-based position in each row. */
	index: number
	/** Original trimmed header, or a generated display label for a blank header. */
	name: string
	/** Stable unique key generated from the normalized header. */
	key: string
	/** Normalized header used for matching. */
	normalizedName: string
	/** Domain-oriented role inferred from an explicit alias table. */
	role: CsvColumnRole
}

/** One logical data row after the selected header. */
export interface CsvRow {
	/** One-based logical record number from the CSV document. */
	row: number
	/** Uncoerced source values. */
	values: readonly string[]
	/** Recoverable observations attached to this logical row. */
	diagnostics: readonly CsvDiagnostic[]
}

/** Structurally parsed CSV document before domain extraction. */
export interface CsvDocument {
	/** Optional caller-supplied source name. */
	fileName?: string
	/** Encoding used for byte decoding. */
	encoding: CsvEncoding
	/** Selected delimiter. */
	delimiter: CsvDelimiter
	/** Observed line-ending style. */
	lineEnding: CsvLineEnding
	/** One-based logical row selected as the header. */
	headerRow: number
	/** Parsed columns in source order. */
	columns: readonly CsvColumn[]
	/** Non-empty data rows after the header. */
	rows: readonly CsvRow[]
	/** Logical records skipped before the selected header. */
	preamble: readonly (readonly string[])[]
	/** Recoverable input observations. */
	diagnostics: readonly CsvDiagnostic[]
}

/** Caller-controlled parser behavior and safety limits. */
export interface ParseCsvOptions {
	/** Optional source name included in the returned document. */
	fileName?: string
	/** Force a delimiter or use automatic dialect detection. @default 'auto' */
	delimiter?: CsvDelimiter | 'auto'
	/** Force a one-based header row or detect it automatically. @default 'auto' */
	headerRow?: number | 'auto'
	/** Force byte decoding or detect UTF-8 with a Windows-1252 fallback. @default 'auto' */
	encoding?: 'auto' | Exclude<CsvEncoding, 'utf-8-bom'>
	/** Additional header aliases merged with the package defaults. */
	headerAliases?: CsvHeaderAliasOverrides
	/** Maximum accepted source bytes for `parseCsvBytes`. @default 67108864 */
	maxBytes?: number
	/** Maximum accepted decoded UTF-16 code units. @default 67108864 */
	maxCharacters?: number
	/** Maximum accepted data rows. @default 1000000 */
	maxRows?: number
	/** Maximum accepted source columns. @default 512 */
	maxColumns?: number
	/** Maximum accepted UTF-16 code units in one cell. @default 1000000 */
	maxCellLength?: number
	/** Maximum records inspected during automatic header selection. @default 25 */
	headerScanLimit?: number
}

/** Stable machine-readable parse failure codes. */
export type CsvParseErrorCode =
	| 'cell-too-large'
	| 'empty-file'
	| 'invalid-csv'
	| 'invalid-header-row'
	| 'missing-header'
	| 'source-too-large'
	| 'too-many-columns'
	| 'too-many-rows'

/** Stable unrecoverable parse error. */
export class CsvParseError extends Error {
	/** Machine-readable failure code. */
	public readonly code: CsvParseErrorCode
	/** One-based row related to the failure, when known. */
	public readonly row?: number
	/** One-based column related to the failure, when known. */
	public readonly column?: number

	public constructor(
		code: CsvParseErrorCode,
		message: string,
		row?: number,
		column?: number,
	) {
		super(message)
		this.name = 'CsvParseError'
		this.code = code
		if (row !== undefined) this.row = row
		if (column !== undefined) this.column = column
	}
}

/** Metadata resolved before streamed data rows are consumed. */
export interface CsvStreamMetadata {
	/** Optional caller-supplied source name. */
	fileName?: string
	/** Encoding used to decode the byte stream. */
	encoding: CsvEncoding
	/** Selected field delimiter. */
	delimiter: CsvDelimiter
	/** One-based logical record selected as the header. */
	headerRow: number
	/** Parsed columns in source order. */
	columns: readonly CsvColumn[]
	/** Logical records skipped before the selected header. */
	preamble: readonly (readonly string[])[]
	/** Recoverable observations discovered before row streaming begins. */
	diagnostics: readonly CsvDiagnostic[]
}

/** One-shot, backpressure-aware CSV document. */
export interface CsvStreamDocument extends CsvStreamMetadata, AsyncDisposable {
	/**
	 * Logical data rows produced as the consumer requests them.
	 *
	 * The iterable is intentionally one-shot because replaying a network or file
	 * stream would require buffering the complete source.
	 */
	rows: AsyncIterable<CsvRow>
}

/** Streaming parser behavior and bounded discovery limits. */
export interface ParseCsvStreamOptions extends Omit<ParseCsvOptions, 'maxCharacters'> {
	/** Maximum bytes read while detecting encoding and delimiter. @default 262144 */
	peekBytes?: number
}
