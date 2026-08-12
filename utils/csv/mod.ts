/**
 * Runtime-neutral CSV parsing built around Web Streams.
 *
 * The streaming API is primary. Collecting APIs remain available for previews,
 * fixtures, and callers that intentionally accept whole-document memory use.
 *
 * @module
 */

export {
	DEFAULT_CSV_HEADER_ALIASES,
	classifyCsvHeader,
	createCsvHeaderClassifier,
	normalizeCsvHeader,
} from './headers.ts'
export { parseCsv, parseCsvBytes } from './parse.ts'
export { parseCsvStream } from './stream.ts'
export { CsvParseError } from './types.ts'
export type {
	CsvColumn,
	CsvColumnRole,
	CsvDelimiter,
	CsvDiagnostic,
	CsvDiagnosticCode,
	CsvDocument,
	CsvEncoding,
	CsvHeaderAliases,
	CsvHeaderAliasOverrides,
	CsvLineEnding,
	CsvRow,
	CsvStreamDocument,
	CsvStreamMetadata,
	ParseCsvOptions,
	ParseCsvStreamOptions,
} from './types.ts'
